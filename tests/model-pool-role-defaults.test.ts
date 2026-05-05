/**
 * applyRoleDefaults — wiring ROLE_LOAD_CONFIG в pool.acquire.
 *
 * Проверяем что:
 *   1. Известная роль (evaluator/vision_meta/etc.) подмешивает дефолты из ROLE_LOAD_CONFIG.
 *   2. Caller-передаваемые значения имеют приоритет над дефолтами роли.
 *   3. Неизвестная роль (e.g. "evaluator-prewarm", "ui-load") не подмешивает ничего.
 *   4. role=undefined не падает.
 *
 * Тестируем через интеграционный путь: ModelPool с моком loadFn ловит финальные opts.
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { ModelPool, type PoolAcquireOptions } from "../electron/lib/llm/model-pool.js";
import type { LoadedModelInfo, DownloadedModelInfo, LoadOptions } from "../electron/lmstudio-client.js";

interface CapturedLoad {
  modelKey: string;
  opts: LoadOptions;
}

class CaptureFake {
  loaded: LoadedModelInfo[] = [];
  downloaded: DownloadedModelInfo[] = [];
  capturedLoads: CapturedLoad[] = [];
  private clock = 0;

  now(): number {
    return ++this.clock;
  }

  setDownloaded(items: Array<{ modelKey: string; sizeBytes: number }>): void {
    this.downloaded = items.map((m) => ({ modelKey: m.modelKey, sizeBytes: m.sizeBytes }));
  }

  loadModelFn = async (modelKey: string, opts: LoadOptions): Promise<LoadedModelInfo> => {
    this.capturedLoads.push({ modelKey, opts: { ...opts } });
    const info: LoadedModelInfo = {
      identifier: `instance-${modelKey}-${this.capturedLoads.length}`,
      modelKey,
    };
    this.loaded.push(info);
    return info;
  };

  unloadModelFn = async (identifier: string): Promise<void> => {
    this.loaded = this.loaded.filter((m) => m.identifier !== identifier);
  };

  listLoadedFn = async (): Promise<LoadedModelInfo[]> => [...this.loaded];
  listDownloadedFn = async (): Promise<DownloadedModelInfo[]> => [...this.downloaded];
}

function makePool(fake: CaptureFake): ModelPool {
  return new ModelPool({
    loadModelFn: fake.loadModelFn,
    unloadModelFn: fake.unloadModelFn,
    listLoadedFn: fake.listLoadedFn,
    listDownloadedFn: fake.listDownloadedFn,
    capacityMB: 64 * 1024,
    now: () => fake.now(),
  });
}

describe("applyRoleDefaults — known roles подмешивают дефолты", () => {
  let fake: CaptureFake;

  beforeEach(() => {
    fake = new CaptureFake();
    fake.setDownloaded([{ modelKey: "test-model", sizeBytes: 4_000_000_000 }]);
  });

  it("role=evaluator получает contextLength=4096 из ROLE_LOAD_CONFIG", async () => {
    const pool = makePool(fake);
    const opts: PoolAcquireOptions = { role: "evaluator" };
    /* contextLength НЕ передан caller'ом → должен взяться из ROLE_LOAD_CONFIG.evaluator.contextLength=4096 */
    const handle = await pool.acquire("test-model", opts);
    handle.release();

    expect(fake.capturedLoads.length).toBe(1);
    expect(fake.capturedLoads[0]?.opts.contextLength).toBe(4096);
  });

  it("role=crystallizer получает contextLength=32768 (длинный context)", async () => {
    const pool = makePool(fake);
    await pool.acquire("test-model", { role: "crystallizer" });
    expect(fake.capturedLoads[0]?.opts.contextLength).toBe(32768);
  });

  it("role=vision_ocr получает contextLength=8192 + gpuOffload=max", async () => {
    const pool = makePool(fake);
    await pool.acquire("test-model", { role: "vision_ocr" });
    expect(fake.capturedLoads[0]?.opts.contextLength).toBe(8192);
    expect(fake.capturedLoads[0]?.opts.gpuOffload).toBe("max");
  });
});

describe("applyRoleDefaults — caller priority", () => {
  let fake: CaptureFake;

  beforeEach(() => {
    fake = new CaptureFake();
    fake.setDownloaded([{ modelKey: "test-model", sizeBytes: 4_000_000_000 }]);
  });

  it("caller-передаваемый contextLength НЕ перезатирается дефолтом роли", async () => {
    const pool = makePool(fake);
    /* role=evaluator имеет default 4096, но caller указал явно 16384 — должен победить. */
    await pool.acquire("test-model", { role: "evaluator", contextLength: 16384 });
    expect(fake.capturedLoads[0]?.opts.contextLength).toBe(16384);
  });

  it("caller-передаваемый gpuOffload НЕ перезатирается", async () => {
    const pool = makePool(fake);
    /* role=vision_ocr default gpu="max", caller хочет 0.5 — должно быть 0.5. */
    await pool.acquire("test-model", { role: "vision_ocr", gpuOffload: 0.5 });
    expect(fake.capturedLoads[0]?.opts.gpuOffload).toBe(0.5);
  });
});

describe("applyRoleDefaults — unknown roles не подмешивают", () => {
  let fake: CaptureFake;

  beforeEach(() => {
    fake = new CaptureFake();
    fake.setDownloaded([{ modelKey: "test-model", sizeBytes: 4_000_000_000 }]);
  });

  it("role='evaluator-prewarm' (нет в ROLE_LOAD_CONFIG) → contextLength undefined", async () => {
    const pool = makePool(fake);
    await pool.acquire("test-model", { role: "evaluator-prewarm" });
    /* НЕ должен подмешать contextLength=4096 (это бы сделал, если бы матчил "evaluator"). */
    expect(fake.capturedLoads[0]?.opts.contextLength).toBe(undefined);
  });

  it("role='ui-load' → no defaults", async () => {
    const pool = makePool(fake);
    await pool.acquire("test-model", { role: "ui-load" });
    expect(fake.capturedLoads[0]?.opts.contextLength).toBe(undefined);
    expect(fake.capturedLoads[0]?.opts.gpuOffload).toBe(undefined);
  });

  it("role=undefined → no defaults", async () => {
    const pool = makePool(fake);
    await pool.acquire("test-model", {});
    expect(fake.capturedLoads[0]?.opts.contextLength).toBe(undefined);
  });
});

/* MVP v1.0.1: removed gpu mapping test that referenced deleted lang_detector role.
   Vision roles already cover the gpuOffload="max" code path above. */
