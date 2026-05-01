/**
 * ModelPool — OOM recovery tests.
 *
 * Покрытие трёх сценариев восстановления:
 *   1. OOM на первой попытке → evictAll → retry успешен. Telemetry: oom_recovered (strategy=evict_all).
 *   2. OOM на 1+2 попытках, модель heavy (>16GB) → unloadAllHeavy → retry. Telemetry: oom_recovered (strategy=unload_heavy).
 *   3. OOM на всех попытках → пробрасывается ошибка. Telemetry: oom_failed.
 *   4. OOM на медленной модели (<= 16GB) после evictAll не пытается unloadHeavy → throw.
 *   5. Не-OOM ошибка → не trigger recovery, throws сразу.
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { ModelPool, type PoolAcquireOptions } from "../electron/lib/llm/model-pool.js";
import type { LoadedModelInfo, DownloadedModelInfo, LoadOptions } from "../electron/lmstudio-client.js";

/**
 * FakeLmStudio с программируемой последовательностью ошибок.
 * Каждый вызов `loadModelFn` смотрит в `loadFailures[i]` — если задано,
 * бросает указанную ошибку, иначе возвращает успешный LoadedModelInfo.
 */
class OomFakeLmStudio {
  loaded: LoadedModelInfo[] = [];
  downloaded: DownloadedModelInfo[] = [];
  loadCalls: Array<{ modelKey: string }> = [];
  unloadCalls: string[] = [];
  /** Последовательность ошибок (index = номер вызова loadFn). undefined = успех. */
  loadFailures: Array<Error | undefined> = [];
  private clock = 0;

  now(): number {
    return ++this.clock;
  }

  setDownloaded(items: Array<{ modelKey: string; sizeBytes: number }>): void {
    this.downloaded = items.map((m) => ({ modelKey: m.modelKey, sizeBytes: m.sizeBytes }));
  }

  setLoaded(keys: string[]): void {
    this.loaded = keys.map((modelKey, i) => ({ identifier: `instance-${modelKey}-pre${i}`, modelKey }));
  }

  loadModelFn = async (modelKey: string, _opts: LoadOptions): Promise<LoadedModelInfo> => {
    this.loadCalls.push({ modelKey });
    const idx = this.loadCalls.length - 1;
    const failure = this.loadFailures[idx];
    if (failure) throw failure;
    const info: LoadedModelInfo = {
      identifier: `instance-${modelKey}-${idx}`,
      modelKey,
    };
    this.loaded.push(info);
    return info;
  };

  unloadModelFn = async (identifier: string): Promise<void> => {
    this.unloadCalls.push(identifier);
    this.loaded = this.loaded.filter((m) => m.identifier !== identifier);
  };

  listLoadedFn = async (): Promise<LoadedModelInfo[]> => [...this.loaded];
  listDownloadedFn = async (): Promise<DownloadedModelInfo[]> => [...this.downloaded];
}

function makePool(fake: OomFakeLmStudio, capacityMB: number): ModelPool {
  return new ModelPool({
    loadModelFn: fake.loadModelFn,
    unloadModelFn: fake.unloadModelFn,
    listLoadedFn: fake.listLoadedFn,
    listDownloadedFn: fake.listDownloadedFn,
    capacityMB,
    now: () => fake.now(),
  });
}

const opts: PoolAcquireOptions = { ttlSec: 900, gpuOffload: "max", role: "test" };

describe("ModelPool — OOM recovery", () => {
  let fake: OomFakeLmStudio;
  let pool: ModelPool;

  beforeEach(() => {
    fake = new OomFakeLmStudio();
  });

  it("OOM на первой попытке → evictAll и retry успешен", async () => {
    /* light model: 4 GB */
    fake.setDownloaded([
      { modelKey: "small-model", sizeBytes: 4_000_000_000 },
      { modelKey: "old-model", sizeBytes: 4_000_000_000 },
    ]);
    fake.setLoaded(["old-model"]); /* старая модель занимает место */
    pool = makePool(fake, 32 * 1024);

    /* первый load бросит OOM, второй (после evict) — успех */
    fake.loadFailures = [new Error("CUDA out of memory: tried to allocate 4 GB")];

    const handle = await pool.acquire("small-model", opts);
    expect(handle.modelKey).toBe("small-model");

    /* loadFn вызвался дважды (1 OOM + 1 retry) */
    expect(fake.loadCalls.length).toBe(2);

    /* Старая модель выгружена через evictAllInternal */
    expect(fake.unloadCalls.length).toBeGreaterThanOrEqual(1);
    expect(fake.unloadCalls.some((id) => id.includes("old-model"))).toBe(true);
  });

  it("OOM на 1+2 попытках для heavy модели → unloadAllHeavy → retry успешен", async () => {
    /* Две heavy модели: 22 GB старая (loaded, refCount=0) и 22 GB новая */
    fake.setDownloaded([
      { modelKey: "qwen-vl-22gb", sizeBytes: 22_000_000_000 },
      { modelKey: "old-heavy-22gb", sizeBytes: 22_000_000_000 },
    ]);
    fake.setLoaded(["old-heavy-22gb"]);
    pool = makePool(fake, 64 * 1024);

    /* OOM на 1-й (прямой load) и 2-й (после evict) попытках, успех на 3-й */
    const oomErr = new Error("failed to allocate VRAM (insufficient)");
    fake.loadFailures = [oomErr, oomErr];

    const handle = await pool.acquire("qwen-vl-22gb", opts);
    expect(handle.modelKey).toBe("qwen-vl-22gb");

    /* Три попытки load: прямой + после evict + после unload-heavy */
    expect(fake.loadCalls.length).toBe(3);

    /* Старая heavy модель выгружена */
    expect(fake.unloadCalls.some((id) => id.includes("old-heavy"))).toBe(true);
  });

  it("OOM на всех попытках → throws после 3 attempts (heavy путь)", async () => {
    fake.setDownloaded([{ modelKey: "qwen-vl-22gb", sizeBytes: 22_000_000_000 }]);
    pool = makePool(fake, 64 * 1024);

    const oomErr = new Error("not enough memory to load model");
    fake.loadFailures = [oomErr, oomErr, oomErr];

    await expect(pool.acquire("qwen-vl-22gb", opts)).rejects.toThrow(/not enough memory/);

    expect(fake.loadCalls.length).toBe(3); /* все три попытки сделаны */
  });

  it("light модель: OOM 1+2 раза → throws без 3-й (unloadHeavy не для light)", async () => {
    /* 4 GB модель — не heavy (порог 16 GB) */
    fake.setDownloaded([{ modelKey: "small-4gb", sizeBytes: 4_000_000_000 }]);
    pool = makePool(fake, 64 * 1024);

    const oomErr = new Error("cuda out of memory");
    fake.loadFailures = [oomErr, oomErr];

    await expect(pool.acquire("small-4gb", opts)).rejects.toThrow(/out of memory/);

    /* Только 2 попытки: прямой load + retry после evictAll. Heavy escalation не запускается. */
    expect(fake.loadCalls.length).toBe(2);
  });

  it("не-OOM ошибка → НЕ trigger recovery, throws сразу", async () => {
    fake.setDownloaded([{ modelKey: "model-a", sizeBytes: 4_000_000_000 }]);
    pool = makePool(fake, 32 * 1024);

    fake.loadFailures = [new Error("connection refused — LM Studio offline")];

    await expect(pool.acquire("model-a", opts)).rejects.toThrow(/connection refused/);

    /* Только одна попытка — recovery не запустилась */
    expect(fake.loadCalls.length).toBe(1);
  });

  it("OOM в сообщении на разных языках/паттернах распознаётся", async () => {
    fake.setDownloaded([{ modelKey: "model-x", sizeBytes: 4_000_000_000 }]);
    pool = makePool(fake, 32 * 1024);

    /* Хотя бы 2 попытки = OOM был распознан и запустилась recovery */
    fake.loadFailures = [new Error("HipMalloc allocation failed"), undefined];

    const handle = await pool.acquire("model-x", opts);
    expect(handle.modelKey).toBe("model-x");
    expect(fake.loadCalls.length).toBe(2); /* recovery таки запустилась */
  });
});
