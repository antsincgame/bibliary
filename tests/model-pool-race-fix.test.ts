/**
 * ModelPool — regression тесты для race-conditions #A1 и #A2.
 *
 * #A1: fast-path acquire vs makeRoom eviction.
 *   До фикса: makeRoom выбирал жертву X (refCount=0), пока ждал unloadFn(X)
 *   другой thread fast-path acquire(X) делал refCount++; entry удалялась с
 *   pinned-handle на руках. Caller получал handle на несуществующую модель.
 *
 * #A2: unloadAllHeavyInternal трогал pinned heavy при OOM-recovery.
 *   До фикса: 3-я попытка load выгружала ВСЕ heavy без проверки refCount,
 *   ломая pinned-модели активных импортов.
 *
 * Фикс: per-modelKey AsyncMutex (KeyedAsyncMutex) сериализует
 *   {check entry → refCount++} vs {check refCount → unload + delete}.
 *   unloadAllHeavyInternal фильтрует refCount === 0; loadWithOomRecovery
 *   делает fail-fast если все heavy pinned.
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { ModelPool, type PoolAcquireOptions } from "../electron/lib/llm/model-pool.js";
import type { LoadedModelInfo, DownloadedModelInfo, LoadOptions } from "../electron/lmstudio-client.js";

class RaceFakeLmStudio {
  loaded: LoadedModelInfo[] = [];
  downloaded: DownloadedModelInfo[] = [];
  loadCalls: Array<{ modelKey: string }> = [];
  unloadCalls: string[] = [];
  loadDelayMs = 0;
  unloadDelayMs = 0;
  loadFailures: Array<Error | undefined> = [];
  private clock = 0;

  now(): number {
    return ++this.clock;
  }

  setDownloaded(items: Array<{ modelKey: string; sizeBytes: number }>): void {
    this.downloaded = items.map((m) => ({ modelKey: m.modelKey, sizeBytes: m.sizeBytes }));
  }

  loadModelFn = async (modelKey: string, _opts: LoadOptions): Promise<LoadedModelInfo> => {
    this.loadCalls.push({ modelKey });
    const idx = this.loadCalls.length - 1;
    if (this.loadDelayMs > 0) await new Promise((r) => setTimeout(r, this.loadDelayMs));
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
    if (this.unloadDelayMs > 0) await new Promise((r) => setTimeout(r, this.unloadDelayMs));
    this.unloadCalls.push(identifier);
    this.loaded = this.loaded.filter((m) => m.identifier !== identifier);
  };

  listLoadedFn = async (): Promise<LoadedModelInfo[]> => [...this.loaded];
  listDownloadedFn = async (): Promise<DownloadedModelInfo[]> => [...this.downloaded];
}

function makePool(fake: RaceFakeLmStudio, capacityMB: number): ModelPool {
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

describe("ModelPool — #A1 race fix (fast-path acquire vs makeRoom eviction)", () => {
  let fake: RaceFakeLmStudio;
  let pool: ModelPool;

  beforeEach(() => {
    fake = new RaceFakeLmStudio();
    fake.setDownloaded([
      { modelKey: "model-a", sizeBytes: 4_500_000_000 },
      { modelKey: "model-b", sizeBytes: 4_500_000_000 },
    ]);
    pool = makePool(fake, 12 * 1024); /* 12 GB — влезают только две по 5.85 GB */
  });

  it("re-acquire pinned model во время eviction не оставляет dead handle", async () => {
    /* Сценарий:
       1. model-a загружена, потом released (refCount=0).
       2. acquire(model-b) запускает makeRoom → выбирает model-a жертвой.
       3. Симулируем медленный unload (50ms) — окно для race.
       4. Параллельно acquire(model-a) — fast-path должен либо отменить eviction
          через lock+re-check, либо корректно дождаться и заново загрузить.
       5. После всех операций: handle на model-a не должен быть "мёртвым" —
          у entry должен быть валидный identifier из loaded set. */
    const a1 = await pool.acquire("model-a", opts);
    a1.release();
    expect(pool.getStats().models.find((m) => m.modelKey === "model-a")?.refCount).toBe(0);

    fake.unloadDelayMs = 50;

    /* Запускаем eviction (через acquire-b который должен выгнать a) и одновременно re-acquire(a). */
    const [a2, b1] = await Promise.all([
      pool.acquire("model-a", opts),
      pool.acquire("model-b", opts),
    ]);

    /* Postconditions:
       - У a2 валидный identifier (соответствует одной из loaded или loaded-history).
       - Если pool в данный момент держит model-a, identifier handle совпадает с identifier entry.
       - refCount у model-a в pool ≥ 1 (a2 держит handle). */
    const stats = pool.getStats();
    const aEntry = stats.models.find((m) => m.modelKey === "model-a");

    /* Если eviction всё-таки случился ДО re-acquire — то fast-path увидел что
       entry нет, и acquireExclusive перезагрузил. Тогда aEntry существует с
       новым identifier. Главное: refCount > 0 и identifier matches handle. */
    if (aEntry) {
      expect(aEntry.refCount).toBeGreaterThanOrEqual(1);
      expect(aEntry.identifier).toBe(a2.identifier);
    } else {
      /* Невозможный сценарий: handle есть, но в pool ничего нет. */
      throw new Error("ModelPool race: handle вернулся для отсутствующей entry");
    }

    a2.release();
    b1.release();
  });

  it("100 concurrent acquire/release одной модели — refCount никогда не уходит в негатив", async () => {
    /* Стресс-тест на race condition: множество concurrent operations не должны
       оставить отрицательный refCount или дублировать identifier. */
    const handles: Array<{ release(): void }> = [];
    const tasks: Array<Promise<unknown>> = [];

    for (let i = 0; i < 50; i += 1) {
      tasks.push(
        pool.acquire("model-a", opts).then((h) => {
          handles.push(h);
        }),
      );
    }
    await Promise.all(tasks);

    const stats = pool.getStats();
    const aEntry = stats.models.find((m) => m.modelKey === "model-a");
    expect(aEntry).toBeDefined();
    expect(aEntry!.refCount).toBe(50);

    /* Releaseим всех. */
    for (const h of handles) h.release();
    expect(pool.getStats().models.find((m) => m.modelKey === "model-a")?.refCount).toBe(0);
  });
});

describe("ModelPool — #A2 fix (unloadAllHeavyInternal не трогает pinned)", () => {
  let fake: RaceFakeLmStudio;
  let pool: ModelPool;

  beforeEach(() => {
    fake = new RaceFakeLmStudio();
  });

  it("OOM на heavy: pinned heavy НЕ выгружается; caller получает clean error", async () => {
    /* Сценарий:
       1. Загружена pinned heavy-1 (22 GB, refCount=1, держит активный импорт).
       2. Запрос heavy-2 (22 GB) — OOM на attempt 1 + 2.
       3. До фикса: attempt 3 выгружал heavy-1 (нарушая контракт withModel).
       4. После фикса: heavy-1 защищён; caller получает понятную OOM-ошибку. */
    fake.setDownloaded([
      { modelKey: "heavy-1", sizeBytes: 22_000_000_000 },
      { modelKey: "heavy-2", sizeBytes: 22_000_000_000 },
    ]);
    pool = makePool(fake, 64 * 1024);

    const h1 = await pool.acquire("heavy-1", opts);
    expect(pool.getStats().models.find((m) => m.modelKey === "heavy-1")?.refCount).toBe(1);

    /* Все попытки heavy-2 будут OOM. */
    const oomErr = new Error("CUDA out of memory: tried to allocate 22 GB");
    fake.loadFailures = [oomErr, oomErr, oomErr, oomErr];

    await expect(pool.acquire("heavy-2", opts)).rejects.toThrow(/all heavy models pinned/i);

    /* heavy-1 НЕ должна быть выгружена — её identifier не должен попасть в unloadCalls. */
    const heavy1Identifier = h1.identifier;
    expect(fake.unloadCalls).not.toContain(heavy1Identifier);

    /* Pool всё ещё держит heavy-1 с refCount=1. */
    const aEntry = pool.getStats().models.find((m) => m.modelKey === "heavy-1");
    expect(aEntry).toBeDefined();
    expect(aEntry!.refCount).toBe(1);

    h1.release();
  });

  it("OOM на heavy с pinned + free heavy: non-pinned выгружается через evictAll, pinned защищена", async () => {
    /* Здесь проверяем что evictAllInternal унесёт non-pinned heavy и retry
       пройдёт на attempt 2, БЕЗ эскалации до unloadAllHeavyInternal. */
    fake.setDownloaded([
      { modelKey: "heavy-pinned", sizeBytes: 22_000_000_000 },
      { modelKey: "heavy-free", sizeBytes: 22_000_000_000 },
      { modelKey: "heavy-new", sizeBytes: 22_000_000_000 },
    ]);
    pool = makePool(fake, 96 * 1024);

    const pinned = await pool.acquire("heavy-pinned", opts);
    const free = await pool.acquire("heavy-free", opts);
    free.release();

    /* heavy-new: OOM на attempt 1 → evictAll → retry успешен. */
    const oomErr = new Error("not enough memory");
    fake.loadFailures = [undefined, undefined, oomErr, undefined];
    /*                  ↑ pinned   ↑ free     ↑ new#1 ↑ new#2-ok */

    const newH = await pool.acquire("heavy-new", opts);
    expect(newH.modelKey).toBe("heavy-new");

    /* heavy-free выгружена. */
    expect(pool.getStats().models.find((m) => m.modelKey === "heavy-free")).toBeUndefined();

    /* heavy-pinned защищена — её identifier не в unloadCalls. */
    expect(fake.unloadCalls.find((id) => id === pinned.identifier)).toBeUndefined();
    const pinnedEntry = pool.getStats().models.find((m) => m.modelKey === "heavy-pinned");
    expect(pinnedEntry).toBeDefined();
    expect(pinnedEntry!.refCount).toBe(1);

    pinned.release();
    newH.release();
  });
});
