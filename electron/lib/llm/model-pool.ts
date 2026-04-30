/**
 * ModelPool — централизованный пул загруженных моделей LM Studio.
 *
 * Цель: при работе пайплайна (импорт книги → crystallizer → judge → translator)
 * не выгружать модель A, чтобы загрузить B, а потом обратно A — что добавляет
 * 5-30 секунд каждой переключки. Если в VRAM влезает 3 модели — держим все три,
 * выгружаем самую старую только когда место кончилось.
 *
 * АРХИТЕКТУРА:
 *
 *   acquire(modelKey, opts) → handle    Гарантирует что модель загружена.
 *   handle.release()                     refCount-- (НЕ выгружает сразу).
 *   withModel(key, opts, fn)             Auto-release wrapper (try/finally).
 *
 *   getStats()                           Дамп состояния для UI/диагностики.
 *   evictAll()                           Полная зачистка (для тестов / диагностики).
 *
 * ПРИНЦИПЫ:
 *
 *   1. **Мьютекс на load/unload** — LM Studio один процесс, две одновременные
 *      загрузки могут крашить сервер или занять двойную VRAM. Все mut-операции
 *      идут через promise-chain (`runOnChain`).
 *
 *   2. **In-flight dedup** — если два места одновременно дернут acquire("X"),
 *      реальный load запустится один раз, оба получат тот же handle.
 *
 *   3. **Sync из LM Studio при acquire** — модели могут быть загружены
 *      пользователем через UI или прошлой сессией. Pool учитывает их как
 *      `refCount=0` и эвиктит по LRU.
 *
 *   4. **Capacity-aware LRU eviction** — если новой модели не хватает места,
 *      выгружаем самые старые с `refCount === 0`. Если все pinned — НЕ ломаем
 *      работу: пробуем загрузить новую, рассчитывая на mmap LM Studio.
 *      (LM Studio сам OOM'нет если реально нет места — это видно как ошибка
 *      load, и acquire выбросит).
 *
 *   5. **Все зависимости через DI** — для тестов передаются моки
 *      loadModelFn/unloadModelFn/listLoadedFn/listDownloadedFn/now.
 *
 * НЕ ДЕЛАЕТ:
 *   - Не вмешивается в Olympics (свой lifecycle через `lib/llm/arena/lms-client.ts`).
 *   - Не управляет user-driven IPC `lmstudio:load`/`unload` (явные действия пользователя).
 *   - Не оценивает фактическую free VRAM (LM Studio её не отдаёт). Capacity = total*0.85.
 */

import {
  listLoaded as defaultListLoaded,
  listDownloaded as defaultListDownloaded,
  loadModel as defaultLoadModel,
  unloadModel as defaultUnloadModel,
  type LoadedModelInfo,
  type DownloadedModelInfo,
  type LoadOptions,
} from "../../lmstudio-client.js";
import { detectHardware } from "../hardware/profiler.js";
import { globalLlmLock } from "./global-llm-lock.js";

/* ─── Public types ──────────────────────────────────────────────────── */

export interface PoolAcquireOptions {
  /** TTL в секундах для LM Studio (после последнего use). 0/undefined = пока процесс жив. */
  ttlSec?: number;
  /** Кто запрашивает (для логов и stats): "evaluator" | "crystallizer" | ... */
  role?: string;
  /** Контекст-длина (если требуется отличная от дефолта). */
  contextLength?: number;
  /** GPU offload: "max" или 0..1. */
  gpuOffload?: "max" | number;
}

export interface PoolHandle {
  modelKey: string;
  identifier: string;
  /** Освободить (refCount--). НЕ выгружает сразу — LRU/eviction только при need. */
  release(): void;
}

export interface PoolEntry {
  modelKey: string;
  identifier: string;
  vramMB: number;
  refCount: number;
  lastUsed: number;
  role?: string;
  /** Источник учёта: pool сам загрузил или подтянул через sync. */
  source: "pool" | "external";
}

export interface PoolStats {
  capacityMB: number;
  loadedCount: number;
  totalLoadedMB: number;
  totalReservedMB: number;
  pendingOps: number;
  models: PoolEntry[];
}

export interface ModelPoolDeps {
  loadModelFn?: (modelKey: string, opts: LoadOptions) => Promise<LoadedModelInfo>;
  unloadModelFn?: (identifier: string) => Promise<void>;
  listLoadedFn?: () => Promise<LoadedModelInfo[]>;
  listDownloadedFn?: () => Promise<DownloadedModelInfo[]>;
  /** Capacity в MB. Если undefined — авто из hardware. */
  capacityMB?: number;
  now?: () => number;
}

/* ─── VRAM estimation ───────────────────────────────────────────────── */

/**
 * Оценка VRAM модели по `sizeBytes` или fallback на парсинг `modelKey`.
 * Эмпирическое правило: weights × 1.3 (KV cache + activations + runtime).
 *
 * Возвращает MB. Если ничего не нашли — 4096 MB (conservative default
 * для 7B Q4, минимум на котором есть смысл вообще что-то держать).
 */
export function estimateVramMBForModel(
  modelKey: string,
  downloaded: DownloadedModelInfo[],
): number {
  const found = downloaded.find((m) => m.modelKey === modelKey);
  if (found?.sizeBytes && found.sizeBytes > 0) {
    return Math.max(256, Math.round((found.sizeBytes * 1.3) / 1024 / 1024));
  }
  if (found?.paramsString) {
    const m = found.paramsString.match(/([\d.]+)\s*B/i);
    if (m) {
      const params = Number(m[1]);
      // Q4 default (~0.5 byte/param) + 30% overhead.
      return Math.round(params * 1000 * 0.5 * 1.3);
    }
  }
  // Fallback: парсинг "qwen3-7b" / "llama-13b" из modelKey.
  const m = modelKey.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (m) {
    const params = Number(m[1]);
    return Math.round(params * 1000 * 0.5 * 1.3);
  }
  return 4096;
}

/**
 * Вычислить capacity (MB) из hardware snapshot.
 * Приоритет: dedicated GPU VRAM × 0.85, fallback RAM × 0.5 (CPU inference).
 * Минимум 4096 MB чтобы хотя бы одна 7B-модель влезла.
 */
export async function computeAutoCapacityMB(): Promise<number> {
  try {
    const hw = await detectHardware();
    if (hw.bestGpu?.vramGB && hw.bestGpu.vramGB >= 4) {
      return Math.max(4096, Math.floor(hw.bestGpu.vramGB * 1024 * 0.85));
    }
    if (hw.ramGB > 0) {
      return Math.max(4096, Math.floor(hw.ramGB * 1024 * 0.5));
    }
  } catch (e) {
    console.warn("[model-pool] computeAutoCapacityMB failed", e);
  }
  return 8192;
}

/* ─── ModelPool ─────────────────────────────────────────────────────── */

export class ModelPool {
  private readonly entries = new Map<string, PoolEntry>();
  private chain: Promise<unknown> = Promise.resolve();
  private pendingOps = 0;
  /** Inflight load дёт только сигнал "загрузка завершена" — refCount каждый
      caller инкрементит сам через fast path после await. */
  private readonly inflight = new Map<string, Promise<void>>();
  private capacityMB: number;
  private capacityResolved: boolean;
  private capacityPromise: Promise<number> | null = null;

  private readonly loadFn: (key: string, opts: LoadOptions) => Promise<LoadedModelInfo>;
  private readonly unloadFn: (identifier: string) => Promise<void>;
  private readonly listLoadedFn: () => Promise<LoadedModelInfo[]>;
  private readonly listDownloadedFn: () => Promise<DownloadedModelInfo[]>;
  private readonly now: () => number;

  constructor(deps: ModelPoolDeps = {}) {
    this.loadFn = deps.loadModelFn ?? defaultLoadModel;
    this.unloadFn = deps.unloadModelFn ?? defaultUnloadModel;
    this.listLoadedFn = deps.listLoadedFn ?? defaultListLoaded;
    this.listDownloadedFn = deps.listDownloadedFn ?? defaultListDownloaded;
    this.now = deps.now ?? (() => Date.now());
    if (typeof deps.capacityMB === "number" && deps.capacityMB > 0) {
      this.capacityMB = deps.capacityMB;
      this.capacityResolved = true;
    } else {
      this.capacityMB = 8192;
      this.capacityResolved = false;
    }
  }

  /**
   * Гарантирует что `modelKey` загружена в LM Studio. Если уже есть —
   * refCount++ и lastUsed=now. Если нет — eviction LRU + load.
   *
   * Параллельные `acquire` одного modelKey деduplicируются (один реальный load).
   */
  async acquire(modelKey: string, opts: PoolAcquireOptions = {}): Promise<PoolHandle> {
    if (!modelKey || typeof modelKey !== "string") {
      throw new Error("ModelPool.acquire: modelKey must be a non-empty string");
    }
    /* Fast path для уже учтённой и pinned модели. */
    const existing = this.entries.get(modelKey);
    if (existing) {
      existing.refCount += 1;
      existing.lastUsed = this.now();
      if (opts.role) existing.role = opts.role;
      return this.makeHandle(existing);
    }

    /* Inflight dedup — два concurrent acquire одного key не должны грузить
       дважды. Ждём текущей загрузки, потом каждый caller сам инкрементит
       refCount через fast path. */
    const inflight = this.inflight.get(modelKey);
    if (inflight) {
      await inflight.catch(() => undefined);
      const after = this.entries.get(modelKey);
      if (after) {
        after.refCount += 1;
        after.lastUsed = this.now();
        if (opts.role) after.role = opts.role;
        return this.makeHandle(after);
      }
      /* Inflight завершилась с ошибкой и entry нет — fallback на собственный путь. */
    }

    const promise = this.acquireExclusive(modelKey, opts);
    /* Sentinel-promise: не возвращает handle (он принадлежит первому caller),
       а только сигналит "загрузка/ошибка". */
    const sentinel = promise.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.set(modelKey, sentinel);
    try {
      return await promise;
    } finally {
      this.inflight.delete(modelKey);
    }
  }

  private async acquireExclusive(modelKey: string, opts: PoolAcquireOptions): Promise<PoolHandle> {
    return this.runOnChain(async () => {
      await this.ensureCapacityResolved();
      await this.syncFromLmStudio();

      /* Повторно — после sync. */
      const existing = this.entries.get(modelKey);
      if (existing) {
        existing.refCount += 1;
        existing.lastUsed = this.now();
        if (opts.role) existing.role = opts.role;
        return this.makeHandle(existing);
      }

      let downloaded: DownloadedModelInfo[] = [];
      try {
        downloaded = await this.listDownloadedFn();
      } catch {
        /* нет каталога — fallback на парсинг modelKey */
      }
      const vramMB = estimateVramMBForModel(modelKey, downloaded);

      await this.makeRoom(vramMB);

      const info = await this.loadFn(modelKey, {
        contextLength: opts.contextLength,
        ttlSec: opts.ttlSec,
        gpuOffload: opts.gpuOffload,
      });

      const entry: PoolEntry = {
        modelKey: info.modelKey,
        identifier: info.identifier,
        vramMB,
        refCount: 1,
        lastUsed: this.now(),
        role: opts.role,
        source: "pool",
      };
      /* Используем фактический modelKey из LM Studio (info.modelKey), а не
         запрошенный — LM Studio мог нормализовать. */
      this.entries.set(entry.modelKey, entry);
      return this.makeHandle(entry);
    });
  }

  /**
   * Освободить (refCount--). НЕ выгружает — eviction только когда нужно место.
   * Идемпотентно: повторный release одного handle игнорируется (refCount min 0).
   */
  release(modelKey: string): void {
    const entry = this.entries.get(modelKey);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsed = this.now();
  }

  /**
   * Удобный wrapper: acquire → fn → release (try/finally). Если fn бросает —
   * release всё равно случится.
   */
  async withModel<T>(
    modelKey: string,
    opts: PoolAcquireOptions,
    fn: (handle: PoolHandle) => Promise<T>,
  ): Promise<T> {
    const handle = await this.acquire(modelKey, opts);
    try {
      return await fn(handle);
    } finally {
      handle.release();
    }
  }

  /**
   * Освободить все НЕ-pinned (refCount=0) модели — для диагностики /
   * принудительной зачистки перед тяжёлыми операциями (Olympics).
   * Возвращает количество выгруженных.
   */
  async evictAll(): Promise<number> {
    return this.runOnChain(async () => {
      const victims = [...this.entries.values()].filter((e) => e.refCount === 0);
      let unloaded = 0;
      for (const v of victims) {
        try {
          await this.unloadFn(v.identifier);
          unloaded += 1;
        } catch (e) {
          console.warn(`[model-pool] evictAll: unload(${v.modelKey}) failed`, e);
        }
        this.entries.delete(v.modelKey);
      }
      return unloaded;
    });
  }

  /**
   * Принудительно подтянуть состояние из LM Studio. Полезно после Olympics
   * (которая грузит/выгружает свои инстансы), или после user-driven UI load/unload.
   */
  async refresh(): Promise<void> {
    await this.runOnChain(async () => {
      await this.syncFromLmStudio();
    });
  }

  getStats(): PoolStats {
    const models = [...this.entries.values()].map((e) => ({ ...e }));
    const totalLoadedMB = models.reduce((s, m) => s + m.vramMB, 0);
    const totalReservedMB = models.filter((m) => m.refCount > 0).reduce((s, m) => s + m.vramMB, 0);
    return {
      capacityMB: this.capacityMB,
      loadedCount: models.length,
      totalLoadedMB,
      totalReservedMB,
      pendingOps: this.pendingOps,
      models,
    };
  }

  /* ─── internal ─────────────────────────────────────────────────────── */

  private makeHandle(entry: PoolEntry): PoolHandle {
    /* release замыкается на modelKey, не на entry — на случай если entry
       позже эвиктнули и тот же modelKey перезагрузили (тогда release
       старого handle не должен трогать новую entry). */
    const capturedKey = entry.modelKey;
    const capturedIdentifier = entry.identifier;
    let released = false;
    return {
      modelKey: capturedKey,
      identifier: capturedIdentifier,
      release: () => {
        if (released) return;
        released = true;
        const cur = this.entries.get(capturedKey);
        /* Сравниваем identifier чтобы не снизить refCount у новой entry,
           если старую успели эвиктнуть и перезагрузить. */
        if (cur && cur.identifier === capturedIdentifier) {
          cur.refCount = Math.max(0, cur.refCount - 1);
          cur.lastUsed = this.now();
        }
      },
    };
  }

  /**
   * Освободить место под `needMB`. Эвиктит LRU среди refCount=0.
   * Если все pinned — пробуем загрузить и надеемся на LM Studio (он сам OOM'нет).
   */
  private async makeRoom(needMB: number): Promise<void> {
    while (this.totalLoadedMB() + needMB > this.capacityMB) {
      const evictable = [...this.entries.values()]
        .filter((e) => e.refCount === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      const victim = evictable[0];
      if (!victim) {
        /* Нет evictable — все pinned. Пробуем продолжить. */
        return;
      }
      try {
        await this.unloadFn(victim.identifier);
      } catch (e) {
        console.warn(`[model-pool] makeRoom: unload(${victim.modelKey}) failed`, e);
        /* Если unload упал — всё равно убираем из учёта чтобы не зациклиться. */
      }
      this.entries.delete(victim.modelKey);
    }
  }

  private totalLoadedMB(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.vramMB;
    return total;
  }

  private async ensureCapacityResolved(): Promise<void> {
    if (this.capacityResolved) return;
    if (!this.capacityPromise) {
      this.capacityPromise = computeAutoCapacityMB();
    }
    try {
      this.capacityMB = await this.capacityPromise;
    } catch {
      /* fall back на дефолт 8192 */
    }
    this.capacityResolved = true;
  }

  /**
   * Синхронизация: подтянуть в учёт модели, которые загружены в LM Studio
   * вне Pool (через user UI / прошлую сессию / Olympics post-cleanup).
   * Удалить из учёта те, которых больше нет в LM Studio.
   */
  private async syncFromLmStudio(): Promise<void> {
    let loaded: LoadedModelInfo[] = [];
    try {
      loaded = await this.listLoadedFn();
    } catch (e) {
      console.warn("[model-pool] syncFromLmStudio: listLoaded failed", e);
      return;
    }
    const presentKeys = new Set(loaded.map((m) => m.modelKey));

    /* Удалить ушедшие. */
    for (const key of [...this.entries.keys()]) {
      if (!presentKeys.has(key)) {
        const e = this.entries.get(key);
        if (e && e.refCount > 0) {
          /* Pinned, но в LM Studio её нет — кто-то выгрузил снаружи.
             Сохраняем учёт чтобы caller получил ошибку при попытке chat. */
          continue;
        }
        this.entries.delete(key);
      }
    }

    /* Добавить новые (внешние). */
    let downloaded: DownloadedModelInfo[] = [];
    let downloadedFetched = false;
    for (const m of loaded) {
      if (this.entries.has(m.modelKey)) continue;
      if (!downloadedFetched) {
        try {
          downloaded = await this.listDownloadedFn();
        } catch {
          /* fallback — vramMB через парсинг modelKey */
        }
        downloadedFetched = true;
      }
      const vramMB = estimateVramMBForModel(m.modelKey, downloaded);
      this.entries.set(m.modelKey, {
        modelKey: m.modelKey,
        identifier: m.identifier,
        vramMB,
        refCount: 0,
        lastUsed: this.now() - 60_000 /* "старше" свежезагруженных, эвиктится первой */,
        source: "external",
      });
    }
  }

  /**
   * Сериализованный исполнитель — все load/unload/sync идут через единую
   * promise-цепь. Гарантирует: одна mut-операция в LM Studio за раз.
   */
  private async runOnChain<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingOps += 1;
    /* Захватываем текущий хвост и продлеваем. Ошибки fn не валят цепь. */
    const prev = this.chain;
    let resolve!: (v: unknown) => void;
    this.chain = new Promise((r) => {
      resolve = r;
    });
    try {
      await prev.catch(() => undefined);
      return await fn();
    } finally {
      resolve(undefined);
      this.pendingOps -= 1;
    }
  }
}

/* ─── Singleton + probe ─────────────────────────────────────────────── */

let defaultPool: ModelPool | null = null;
let probeUnregister: (() => void) | null = null;

/** Получить (или создать) default singleton pool. */
export function getModelPool(): ModelPool {
  if (!defaultPool) {
    defaultPool = new ModelPool();
    /* Probe для globalLlmLock — другие подсистемы видят что пул загружает
       модель и могут уважительно подождать. */
    probeUnregister = globalLlmLock.registerProbe("model-pool", () => {
      const stats = defaultPool!.getStats();
      return stats.pendingOps > 0
        ? { busy: true, reason: `loading/unloading (${stats.pendingOps} ops)` }
        : { busy: false };
    });
  }
  return defaultPool;
}

/** Сбросить singleton (для тестов и hot-reload). */
export function _resetModelPoolForTests(): void {
  if (probeUnregister) {
    probeUnregister();
    probeUnregister = null;
  }
  defaultPool = null;
}
