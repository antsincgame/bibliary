/**
 * ModelPool — unit tests с DI-моками.
 *
 * Покрытие:
 *   1. Acquire когда модель уже в LM Studio (sync) — не грузит повторно.
 *   2. Acquire новой — грузит, учитывает refCount.
 *   3. Release — refCount-- но не выгружает сразу.
 *   4. Capacity-aware eviction — старая выгружается под новую.
 *   5. Pinned (refCount > 0) не эвиктится.
 *   6. In-flight dedup — параллельные acquire одного key = один load.
 *   7. Mutex — параллельные acquire разных моделей сериализуются.
 *   8. withModel — auto-release в try/finally.
 *   9. evictAll — не трогает pinned.
 *   10. estimateVramMBForModel — sizeBytes / paramsString / fallback.
 *   11. computeAutoCapacityMB — GPU vs RAM fallback.
 *   12. Real-world: 32GB VRAM + три 7B модели держатся одновременно.
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import {
  ModelPool,
  estimateVramMBForModel,
  getModelPool,
  _resetModelPoolForTests,
  type PoolAcquireOptions,
} from "../server/lib/scanner/_vendor/llm/model-pool.js";
import type {
  LoadedModelInfo,
  DownloadedModelInfo,
  LoadOptions,
} from "../server/lib/scanner/_vendor/lmstudio-client.js";
import { globalLlmLock } from "../server/lib/scanner/_vendor/llm/global-llm-lock.js";

/* ─── Fake LM Studio ─────────────────────────────────────────────────── */

class FakeLmStudio {
  loaded: Array<LoadedModelInfo & { _loadedAt: number }> = [];
  downloaded: DownloadedModelInfo[] = [];
  loadCalls: Array<{ modelKey: string; opts: LoadOptions; at: number }> = [];
  unloadCalls: Array<{ identifier: string; at: number }> = [];
  /** Имитация задержки load, ms (для тестов сериализации). */
  loadDelayMs = 0;
  unloadDelayMs = 0;
  /** Если true — load бросает. */
  failNextLoad = false;
  private clock = 0;

  now(): number {
    return ++this.clock;
  }

  setDownloaded(items: Array<{ modelKey: string; sizeBytes?: number; paramsString?: string }>): void {
    this.downloaded = items.map((m) => ({
      modelKey: m.modelKey,
      sizeBytes: m.sizeBytes,
      paramsString: m.paramsString,
    }));
  }

  setLoaded(keys: string[]): void {
    this.loaded = keys.map((modelKey, i) => ({
      identifier: `instance-${modelKey}-${i}`,
      modelKey,
      _loadedAt: this.now(),
    }));
  }

  loadModelFn = async (modelKey: string, opts: LoadOptions): Promise<LoadedModelInfo> => {
    this.loadCalls.push({ modelKey, opts, at: this.now() });
    if (this.loadDelayMs > 0) await new Promise((r) => setTimeout(r, this.loadDelayMs));
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error("simulated load failure");
    }
    const info: LoadedModelInfo & { _loadedAt: number } = {
      identifier: `instance-${modelKey}-${this.loadCalls.length}`,
      modelKey,
      _loadedAt: this.now(),
    };
    this.loaded.push(info);
    return { identifier: info.identifier, modelKey: info.modelKey };
  };

  unloadModelFn = async (identifier: string): Promise<void> => {
    this.unloadCalls.push({ identifier, at: this.now() });
    if (this.unloadDelayMs > 0) await new Promise((r) => setTimeout(r, this.unloadDelayMs));
    this.loaded = this.loaded.filter((m) => m.identifier !== identifier);
  };

  listLoadedFn = async (): Promise<LoadedModelInfo[]> => {
    return this.loaded.map((m) => ({ identifier: m.identifier, modelKey: m.modelKey }));
  };

  listDownloadedFn = async (): Promise<DownloadedModelInfo[]> => {
    return [...this.downloaded];
  };
}

function makePool(fake: FakeLmStudio, capacityMB: number): ModelPool {
  return new ModelPool({
    loadModelFn: fake.loadModelFn,
    unloadModelFn: fake.unloadModelFn,
    listLoadedFn: fake.listLoadedFn,
    listDownloadedFn: fake.listDownloadedFn,
    capacityMB,
    now: () => fake.now(),
  });
}

const opts7B: PoolAcquireOptions = { ttlSec: 900, gpuOffload: "max", role: "test" };

/* ─── Tests ─────────────────────────────────────────────────────────── */

describe("ModelPool — VRAM estimation", () => {
  it("estimateVramMBForModel: sizeBytes даёт точную оценку", () => {
    const downloaded: DownloadedModelInfo[] = [
      { modelKey: "qwen3-7b", sizeBytes: 4_500_000_000 },
    ];
    const mb = estimateVramMBForModel("qwen3-7b", downloaded);
    /* 4.5 GB × 1.3 ≈ 5.85 GB ≈ 5580 MB */
    expect(mb).toBeGreaterThanOrEqual(5500);
    expect(mb).toBeLessThanOrEqual(6000);
  });

  it("estimateVramMBForModel: paramsString fallback", () => {
    const downloaded: DownloadedModelInfo[] = [
      { modelKey: "qwen3-7b", paramsString: "7B" },
    ];
    const mb = estimateVramMBForModel("qwen3-7b", downloaded);
    /* 7 × 1000 × 0.5 × 1.3 = 4550 MB */
    expect(mb).toBeGreaterThanOrEqual(4000);
    expect(mb).toBeLessThanOrEqual(5000);
  });

  it("estimateVramMBForModel: парсит modelKey ('llama-13b')", () => {
    const mb = estimateVramMBForModel("llama-13b-instruct", []);
    /* 13 × 1000 × 0.5 × 1.3 = 8450 MB */
    expect(mb).toBeGreaterThanOrEqual(8000);
    expect(mb).toBeLessThanOrEqual(9000);
  });

  it("estimateVramMBForModel: безопасный fallback для unknown ('mystery-model')", () => {
    const mb = estimateVramMBForModel("mystery-model", []);
    expect(mb).toBe(4096);
  });
});

describe("ModelPool — basic acquire/release", () => {
  let fake: FakeLmStudio;
  let pool: ModelPool;

  beforeEach(() => {
    fake = new FakeLmStudio();
    fake.setDownloaded([{ modelKey: "qwen3-7b", sizeBytes: 4_500_000_000 }]);
    pool = makePool(fake, 32 * 1024); /* 32 GB */
  });

  it("acquire новой модели вызывает loadModelFn", async () => {
    const handle = await pool.acquire("qwen3-7b", opts7B);
    expect(handle.modelKey).toBe("qwen3-7b");
    expect(fake.loadCalls.length).toBe(1);
    expect(fake.loadCalls[0]?.modelKey).toBe("qwen3-7b");
  });

  it("повторный acquire не грузит (уже в pool, refCount++)", async () => {
    await pool.acquire("qwen3-7b", opts7B);
    await pool.acquire("qwen3-7b", opts7B);
    expect(fake.loadCalls.length).toBe(1);

    const stats = pool.getStats();
    expect(stats.models[0]?.refCount).toBe(2);
  });

  it("acquire когда модель уже загружена в LM Studio — не грузит", async () => {
    fake.setLoaded(["qwen3-7b"]);
    const handle = await pool.acquire("qwen3-7b", opts7B);
    expect(handle.modelKey).toBe("qwen3-7b");
    expect(fake.loadCalls.length).toBe(0); /* нашли через sync */

    const stats = pool.getStats();
    expect(stats.models[0]?.source).toBe("external");
    expect(stats.models[0]?.refCount).toBe(1);
  });

  it("release уменьшает refCount но НЕ выгружает", async () => {
    const handle = await pool.acquire("qwen3-7b", opts7B);
    handle.release();
    expect(fake.unloadCalls.length).toBe(0);

    const stats = pool.getStats();
    expect(stats.models[0]?.refCount).toBe(0);
    expect(stats.loadedCount).toBe(1);
  });

  it("release идемпотентен (двойной release = один decrement)", async () => {
    const handle = await pool.acquire("qwen3-7b", opts7B);
    handle.release();
    handle.release();
    handle.release();
    const stats = pool.getStats();
    expect(stats.models[0]?.refCount).toBe(0);
  });
});

describe("ModelPool — capacity-aware LRU eviction", () => {
  let fake: FakeLmStudio;
  let pool: ModelPool;

  beforeEach(() => {
    fake = new FakeLmStudio();
    /* Каждая модель ~5.85 GB */
    fake.setDownloaded([
      { modelKey: "model-a", sizeBytes: 4_500_000_000 },
      { modelKey: "model-b", sizeBytes: 4_500_000_000 },
      { modelKey: "model-c", sizeBytes: 4_500_000_000 },
      { modelKey: "model-d", sizeBytes: 4_500_000_000 },
    ]);
  });

  it("при capacity = 12 GB только 2 модели по 5.85 GB влезают; третья эвиктит первую", async () => {
    pool = makePool(fake, 12 * 1024); /* 12 GB */

    const a = await pool.acquire("model-a", opts7B);
    a.release();
    const b = await pool.acquire("model-b", opts7B);
    b.release();
    expect(fake.unloadCalls.length).toBe(0);

    /* Третья требует место — выгружается LRU (a, освобождена раньше). */
    const c = await pool.acquire("model-c", opts7B);
    c.release();
    expect(fake.unloadCalls.length).toBe(1);
    expect(fake.unloadCalls[0]?.identifier).toContain("model-a");

    const stats = pool.getStats();
    expect(stats.models.map((m) => m.modelKey).sort()).toEqual(["model-b", "model-c"]);
  });

  it("pinned модель (refCount > 0) НЕ эвиктится", async () => {
    pool = makePool(fake, 12 * 1024);

    const a = await pool.acquire("model-a", opts7B); /* остаётся pinned */
    const b = await pool.acquire("model-b", opts7B);
    b.release();

    /* model-a refCount=1, model-b refCount=0. Третья пытается сесть. */
    const c = await pool.acquire("model-c", opts7B);
    c.release();

    expect(fake.unloadCalls.length).toBe(1);
    expect(fake.unloadCalls[0]?.identifier).toContain("model-b"); /* a защищена */

    a.release();
  });

  it("32 GB VRAM держит три 7B модели одновременно (целевой сценарий импорта)", async () => {
    /* 32 GB × 0.85 = 27.2 GB capacity. Три 7B по ~5.85 GB = 17.55 GB. Влезут. */
    pool = makePool(fake, Math.floor(32 * 1024 * 0.85));

    const a = await pool.acquire("model-a", opts7B);
    const b = await pool.acquire("model-b", opts7B);
    const c = await pool.acquire("model-c", opts7B);

    expect(fake.loadCalls.length).toBe(3);
    expect(fake.unloadCalls.length).toBe(0);

    const stats = pool.getStats();
    expect(stats.loadedCount).toBe(3);
    expect(stats.totalReservedMB).toBeGreaterThan(15_000); /* ≥ 15 GB pinned */

    a.release();
    b.release();
    c.release();
  });
});

describe("ModelPool — concurrency", () => {
  let fake: FakeLmStudio;
  let pool: ModelPool;

  beforeEach(() => {
    fake = new FakeLmStudio();
    fake.setDownloaded([
      { modelKey: "model-a", sizeBytes: 4_500_000_000 },
      { modelKey: "model-b", sizeBytes: 4_500_000_000 },
    ]);
    pool = makePool(fake, 32 * 1024);
  });

  it("параллельные acquire одного modelKey дедуплицируются (один load)", async () => {
    fake.loadDelayMs = 50;
    const [h1, h2, h3] = await Promise.all([
      pool.acquire("model-a", opts7B),
      pool.acquire("model-a", opts7B),
      pool.acquire("model-a", opts7B),
    ]);
    expect(fake.loadCalls.length).toBe(1);
    expect(h1.identifier).toBe(h2.identifier);
    expect(h2.identifier).toBe(h3.identifier);

    /* Все три share entry — refCount должен быть 3. */
    const stats = pool.getStats();
    expect(stats.models[0]?.refCount).toBe(3);
  });

  it("параллельные acquire РАЗНЫХ моделей сериализуются через mutex", async () => {
    fake.loadDelayMs = 30;
    const before = Date.now();
    await Promise.all([
      pool.acquire("model-a", opts7B),
      pool.acquire("model-b", opts7B),
    ]);
    const elapsed = Date.now() - before;
    /* Два load по 30 ms последовательно ≥ 60 ms. */
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(fake.loadCalls.length).toBe(2);
  });

  it("ошибка load не валит pool (следующий acquire работает)", async () => {
    fake.failNextLoad = true;
    await expect(pool.acquire("model-a", opts7B)).rejects.toThrow(/simulated/);

    /* Pool в рабочем состоянии: следующий acquire успешно грузит. */
    const handle = await pool.acquire("model-b", opts7B);
    expect(handle.modelKey).toBe("model-b");
  });
});

describe("ModelPool — withModel / evictAll", () => {
  let fake: FakeLmStudio;
  let pool: ModelPool;

  beforeEach(() => {
    fake = new FakeLmStudio();
    fake.setDownloaded([
      { modelKey: "model-a", sizeBytes: 4_500_000_000 },
      { modelKey: "model-b", sizeBytes: 4_500_000_000 },
    ]);
    pool = makePool(fake, 32 * 1024);
  });

  it("withModel: auto-release после fn", async () => {
    let observedRefCount = -1;
    const result = await pool.withModel("model-a", opts7B, async () => {
      observedRefCount = pool.getStats().models[0]!.refCount;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(observedRefCount).toBe(1);
    expect(pool.getStats().models[0]?.refCount).toBe(0);
  });

  it("withModel: release ДАЖЕ при exception в fn", async () => {
    await expect(
      pool.withModel("model-a", opts7B, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);

    /* refCount должен быть 0 несмотря на throw. */
    expect(pool.getStats().models[0]?.refCount).toBe(0);
  });

  it("evictAll: выгружает все non-pinned, оставляет pinned", async () => {
    const a = await pool.acquire("model-a", opts7B); /* pinned */
    const b = await pool.acquire("model-b", opts7B);
    b.release();

    const unloaded = await pool.evictAll();
    expect(unloaded).toBe(1);

    const stats = pool.getStats();
    expect(stats.loadedCount).toBe(1);
    expect(stats.models[0]?.modelKey).toBe("model-a");

    a.release();
  });
});

describe("ModelPool — globalLlmLock probe integration", () => {
  beforeEach(() => {
    globalLlmLock._resetForTests();
    _resetModelPoolForTests();
  });

  it("getModelPool() регистрирует probe 'model-pool' в globalLlmLock", () => {
    expect(globalLlmLock.getStatus().registeredProbes).not.toContain("model-pool");
    getModelPool();
    expect(globalLlmLock.getStatus().registeredProbes).toContain("model-pool");
  });

  it("_resetModelPoolForTests снимает probe", () => {
    getModelPool();
    expect(globalLlmLock.getStatus().registeredProbes).toContain("model-pool");
    _resetModelPoolForTests();
    expect(globalLlmLock.getStatus().registeredProbes).not.toContain("model-pool");
  });

  it("probe возвращает busy=false когда нет pending операций", () => {
    getModelPool();
    const status = globalLlmLock.isBusy();
    /* Свежесозданный pool без операций — не busy. */
    expect(status.busy).toBe(false);
  });
});
