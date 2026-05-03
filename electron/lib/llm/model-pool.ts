/**
 * ModelPool — централизованный пул загруженных моделей LM Studio.
 *
 * Цель: при работе пайплайна (импорт книги → crystallizer → translator)
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
 *   - Не оценивает фактическую free VRAM (LM Studio её не отдаёт). Capacity = total*0.85.
 *
 * УПРАВЛЯЕТ (с Итерации 1):
 *   - User-driven IPC `lmstudio:load` теперь идёт через pool.acquire() — это закрывает
 *     gap когда UI грузил модель параллельно с автоматическим pipeline.
 *     `lmstudio:unload` остаётся прямым (явное действие пользователя), но триггерит
 *     `pool.refresh()` чтобы не висели stale entries.
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
import * as telemetry from "../resilience/telemetry.js";
import { classifyByVramMB, evictionPriority, type ModelWeight } from "./model-size-classifier.js";
import { getRoleLoadConfig } from "./role-load-config.js";
import type { ModelRole } from "./model-role-resolver.js";
import { KeyedAsyncMutex } from "./async-mutex.js";

/** Известные ModelRole — синхронизировано с model-role-resolver.ts. */
const KNOWN_MODEL_ROLES: ReadonlySet<ModelRole> = new Set<ModelRole>([
  "crystallizer", "vision_meta", "vision_ocr", "vision_illustration",
  "evaluator", "ukrainian_specialist", "lang_detector", "translator",
  "layout_assistant",
]);

/**
 * Применяет дефолты из ROLE_LOAD_CONFIG к LoadOptions.
 *
 * Caller-передаваемые значения имеют приоритет (если caller указал
 * contextLength=8192, дефолт role не перезатирает). Это решает gap:
 * раньше ROLE_LOAD_CONFIG был объявлен но никем не использовался,
 * и каждая call-site сама дублировала magic numbers (gpuOffload, ttl).
 *
 * Только для ролей из KNOWN_MODEL_ROLES — сторонние строки role
 * (например "evaluator-prewarm", "ui-load", "test") не трогают opts.
 */
function applyRoleDefaults(role: string | undefined, opts: LoadOptions): LoadOptions {
  if (!role || !KNOWN_MODEL_ROLES.has(role as ModelRole)) return opts;
  const cfg = getRoleLoadConfig(role as ModelRole);
  return {
    contextLength: opts.contextLength ?? cfg.contextLength,
    ttlSec: opts.ttlSec,
    gpuOffload: opts.gpuOffload ?? mapGpuRatio(cfg.gpu?.ratio),
  };
}

function mapGpuRatio(ratio: LMSGpuRatio | undefined): "max" | number | undefined {
  if (ratio === undefined) return undefined;
  if (ratio === "off") return 0;
  return ratio;
}

type LMSGpuRatio = "max" | "off" | number;

/* ─── OOM detection helpers ─────────────────────────────────────────── */

/**
 * Эвристика «это ошибка нехватки VRAM/RAM».
 *
 * LM Studio (через @lmstudio/sdk) пробрасывает ошибки от llama.cpp/MLX/CUDA с
 * текстом, в котором обычно есть один из паттернов ниже. Точного error code SDK
 * не даёт — детектим по сообщению.
 *
 * Все паттерны матчатся как ОТДЕЛЬНЫЕ слова (через regex с word boundaries) или
 * как длинные специфичные фразы. Подстрока `"oom"` намеренно убрана — она дала
 * бы false positive на `"zoom failed"`, `"room not available"`, `"bloomberg api"`
 * и подобных сетевых/диагностических ошибках.
 */
function isOomError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes("out of memory") ||
    /\boom\b/.test(lower) ||                        /* word-boundary, не ловит room/zoom/bloom */
    lower.includes("cuda error: out of memory") ||
    lower.includes("failed to allocate") ||
    lower.includes("cannot allocate") ||
    lower.includes("not enough memory") ||
    /vram[^a-z]/.test(lower) && lower.includes("insufficient") ||
    lower.includes("hipmalloc") ||                  /* AMD ROCm */
    lower.includes("metal allocation failed")       /* Apple MLX */
  );
}

const HEAVY_THRESHOLD_MB = 16 * 1024;

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
  /**
   * Классификация по размеру: light/medium/heavy.
   * Используется ImportTaskScheduler для выбора lane и Pool для
   * приоритезации eviction (heavy первая жертва при OOM/makeRoom).
   */
  weight: ModelWeight;
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
  /** Per-modelKey lock: атомарность {check entry → refCount++} vs {check refCount → unload + delete}.
      Без него возможен race: makeRoom выбрал жертву X (refCount=0), пока ждёт unloadFn(X)
      другой thread fast-path сделал refCount++; entry удаляется с pinned-handle на руках. */
  private readonly keyedMutex = new KeyedAsyncMutex(256);
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
    /* Fast path под per-modelKey lock: check + refCount++ атомарны относительно eviction. */
    const fast = await this.keyedMutex.runExclusive(modelKey, async () => {
      const existing = this.entries.get(modelKey);
      if (!existing) return null;
      existing.refCount += 1;
      existing.lastUsed = this.now();
      if (opts.role) existing.role = opts.role;
      return this.makeHandle(existing);
    });
    if (fast) return fast;

    /* Inflight dedup — два concurrent acquire одного key не должны грузить
       дважды. Ждём текущей загрузки, потом снова fast-path под lock. */
    const inflight = this.inflight.get(modelKey);
    if (inflight) {
      await inflight.catch(() => undefined);
      const after = await this.keyedMutex.runExclusive(modelKey, async () => {
        const cur = this.entries.get(modelKey);
        if (!cur) return null;
        cur.refCount += 1;
        cur.lastUsed = this.now();
        if (opts.role) cur.role = opts.role;
        return this.makeHandle(cur);
      });
      if (after) return after;
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

      /* Повторно — после sync. Под lock(modelKey) чтобы быть атомарным
         относительно конкурирующих fast-path acquire / eviction. */
      const afterSync = await this.keyedMutex.runExclusive(modelKey, async () => {
        const cur = this.entries.get(modelKey);
        if (!cur) return null;
        cur.refCount += 1;
        cur.lastUsed = this.now();
        if (opts.role) cur.role = opts.role;
        return this.makeHandle(cur);
      });
      if (afterSync) return afterSync;

      let downloaded: DownloadedModelInfo[] = [];
      try {
        downloaded = await this.listDownloadedFn();
      } catch {
        /* нет каталога — fallback на парсинг modelKey */
      }
      const vramMB = estimateVramMBForModel(modelKey, downloaded);

      await this.makeRoom(vramMB);

      const loadOpts: LoadOptions = applyRoleDefaults(opts.role, {
        contextLength: opts.contextLength,
        ttlSec: opts.ttlSec,
        gpuOffload: opts.gpuOffload,
      });

      const info = await this.loadWithOomRecovery(modelKey, vramMB, loadOpts);

      const entry: PoolEntry = {
        modelKey: info.modelKey,
        identifier: info.identifier,
        vramMB,
        weight: classifyByVramMB(vramMB),
        refCount: 1,
        lastUsed: this.now(),
        role: opts.role,
        source: "pool",
      };
      /* Используем фактический modelKey из LM Studio (info.modelKey), а не
         запрошенный — LM Studio мог нормализовать. Запись делаем под lock,
         чтобы конкурентный acquire(info.modelKey) не увидел частично созданную entry. */
      await this.keyedMutex.runExclusive(entry.modelKey, async () => {
        this.entries.set(entry.modelKey, entry);
      });
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
    return this.runOnChain(async () => this.evictAllInternal());
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
   * Загрузить модель с автоматическим восстановлением при OOM.
   *
   * Стратегия трёхуровневая:
   *   1. Прямой `loadFn`. Если успех — вернуть.
   *   2. Если OOM — `evictAllInternal()` (выгружаем все refCount=0), retry. Часто
   *      решается так, потому что LM Studio мог не понять, что нам нужна VRAM.
   *   3. Если опять OOM И модель тяжёлая (>16 GB) — `unloadAllHeavyInternal()`
   *      (выгружаем все heavy-модели, даже если они в нашем учёте), retry.
   *   4. Если и это OOM — пробрасываем последнюю ошибку с понятным сообщением.
   *
   * При успехе/провале логируем телеметрию (`lmstudio.oom_recovered` /
   * `lmstudio.oom_failed`) для постмортем-анализа.
   *
   * Все шаги eviction идут на той же promise-цепочке `runOnChain`,
   * потому что мы УЖЕ внутри неё — никаких новых вложенных захватов цепочки.
   */
  private async loadWithOomRecovery(
    modelKey: string,
    vramMB: number,
    loadOpts: LoadOptions,
  ): Promise<LoadedModelInfo> {
    const startedAt = this.now();
    let attempts = 0;

    /* Attempt 1 — straight load. */
    attempts += 1;
    try {
      return await this.loadFn(modelKey, loadOpts);
    } catch (err1) {
      if (!isOomError(err1)) throw err1;

      /* Attempt 2 — evictAll then retry. */
      console.warn(`[model-pool] OOM detected for "${modelKey}" (vramMB=${vramMB}); evicting all unpinned and retrying`);
      try {
        await this.evictAllInternal();
      } catch (evictErr) {
        console.warn("[model-pool] evictAllInternal during OOM-recovery failed", evictErr);
      }

      attempts += 1;
      try {
        const info = await this.loadFn(modelKey, loadOpts);
        telemetry.logEvent({
          type: "lmstudio.oom_recovered",
          modelKey,
          vramMB,
          strategy: "evict_all",
          attempts,
          durationMs: this.now() - startedAt,
        });
        return info;
      } catch (err2) {
        if (!isOomError(err2)) throw err2;

        /* Attempt 3 — для тяжёлых моделей выгрузить ВСЕ heavy (даже pinned),
           попробовать снова. Pinned модели потеряют идентификатор, но caller
           получит чистую ошибку при попытке chat — это лучше, чем import
           целиком обрубленный OOM'ом. */
        if (vramMB <= HEAVY_THRESHOLD_MB) {
          telemetry.logEvent({
            type: "lmstudio.oom_failed",
            modelKey,
            vramMB,
            attempts,
            lastError: err2 instanceof Error ? err2.message : String(err2),
          });
          throw err2;
        }

        console.warn(`[model-pool] OOM persisted for heavy model "${modelKey}" after evictAll; unloading all heavy models`);

        /* #A2 fail-fast: если ВСЕ оставшиеся heavy pinned (refCount > 0) — нет смысла
           ни выгружать (мы не трогаем pinned), ни retry'ить. Лучше отдать caller'у
           понятную ошибку чем сломать pinned-модели активных импортов. Обнаружить
           этот случай до unloadAllHeavyInternal: пустой список remaining heavy — НЕ
           ошибка (значит evictAll уже всё унёс, retry оправдан). */
        const remainingHeavy = [...this.entries.values()].filter(
          (e) => e.vramMB > HEAVY_THRESHOLD_MB && e.modelKey !== modelKey,
        );
        const allHeavyPinned =
          remainingHeavy.length > 0 && remainingHeavy.every((e) => e.refCount > 0);
        if (allHeavyPinned) {
          const reason = "all heavy models pinned by active jobs (refCount > 0); cannot evict without breaking them";
          telemetry.logEvent({
            type: "lmstudio.oom_failed",
            modelKey,
            vramMB,
            attempts,
            lastError: reason,
          });
          throw new Error(
            `OOM: cannot load "${modelKey}" (${vramMB} MB). ${reason}. Wait for current operations to complete and retry.`,
          );
        }

        try {
          await this.unloadAllHeavyInternal(modelKey);
        } catch (unloadErr) {
          console.warn("[model-pool] unloadAllHeavyInternal during OOM-recovery failed", unloadErr);
        }

        attempts += 1;
        try {
          const info = await this.loadFn(modelKey, loadOpts);
          telemetry.logEvent({
            type: "lmstudio.oom_recovered",
            modelKey,
            vramMB,
            strategy: "unload_heavy",
            attempts,
            durationMs: this.now() - startedAt,
          });
          return info;
        } catch (err3) {
          telemetry.logEvent({
            type: "lmstudio.oom_failed",
            modelKey,
            vramMB,
            attempts,
            lastError: err3 instanceof Error ? err3.message : String(err3),
          });
          throw err3;
        }
      }
    }
  }

  /**
   * Внутренний evictAll — НЕ берёт runOnChain (мы уже внутри цепочки).
   * Каждая жертва выгружается под per-modelKey lock с re-check refCount,
   * чтобы concurrent fast-path acquire не получил handle на удаляемую entry.
   */
  private async evictAllInternal(): Promise<number> {
    const candidates = [...this.entries.values()].filter((e) => e.refCount === 0);
    let unloaded = 0;
    for (const v of candidates) {
      await this.keyedMutex.runExclusive(v.modelKey, async () => {
        const cur = this.entries.get(v.modelKey);
        /* Re-check: refCount мог увеличиться пока ждали lock (другой thread
           держит handle и не отдал). Не трогаем pinned. */
        if (!cur || cur.refCount > 0) return;
        try {
          await this.unloadFn(cur.identifier);
          unloaded += 1;
        } catch (e) {
          console.warn(`[model-pool] evictAllInternal: unload(${cur.modelKey}) failed`, e);
        }
        this.entries.delete(cur.modelKey);
      });
    }
    return unloaded;
  }

  /**
   * Выгружает все heavy (>16 GB) модели, кроме `exceptKey`. Используется как
   * последняя попытка восстановления при OOM на heavy. Не берёт runOnChain.
   *
   * #A2 invariant: НИКОГДА не трогает pinned модели (refCount > 0). Раньше
   * этот путь нарушал контракт withModel — caller получал handle, потом OOM
   * recovery выгружал ту же модель под ним. Теперь pinned защищены: если
   * все heavy pinned, метод вернёт 0 и caller получит чистую OOM-ошибку.
   */
  private async unloadAllHeavyInternal(exceptKey: string): Promise<number> {
    const candidates = [...this.entries.values()].filter(
      (e) => e.vramMB > HEAVY_THRESHOLD_MB && e.modelKey !== exceptKey && e.refCount === 0,
    );
    let unloaded = 0;
    for (const v of candidates) {
      await this.keyedMutex.runExclusive(v.modelKey, async () => {
        const cur = this.entries.get(v.modelKey);
        if (!cur || cur.refCount > 0) return;
        try {
          await this.unloadFn(cur.identifier);
          unloaded += 1;
        } catch (e) {
          console.warn(`[model-pool] unloadAllHeavyInternal: unload(${cur.modelKey}) failed`, e);
        }
        this.entries.delete(cur.modelKey);
      });
    }
    return unloaded;
  }

  /**
   * Освободить место под `needMB`. Эвиктит LRU среди refCount=0.
   * Если все pinned — пробуем загрузить и надеемся на LM Studio (он сам OOM'нет).
   *
   * #A1 invariant: между выбором жертвы и `unloadFn` НЕ должно быть окна, в
   * котором кто-то увеличит refCount. Берём per-modelKey lock на жертву и
   * под ним повторно проверяем refCount — если стал > 0, пропускаем и берём
   * следующего кандидата.
   *
   * `safetyAttempts` — защита от бесконечного цикла, когда жертвы постоянно
   * становятся pinned под lock (живой fast-path трафик). После N неудач
   * выходим — caller попробует loadFn и если LM Studio OOM, пройдёт через
   * loadWithOomRecovery.
   */
  private async makeRoom(needMB: number): Promise<void> {
    let safetyAttempts = 32;
    while (this.totalLoadedMB() + needMB > this.capacityMB && safetyAttempts > 0) {
      safetyAttempts -= 1;
      /* Композитная сортировка кандидатов на выселение:
         1. Сначала по weight (heavy первая жертва — освобождает больше места,
            обычно дороже держать неиспользуемой). evictionPriority: heavy=3>medium=2>light=1.
         2. При равном весе — LRU (старшая по lastUsed первой). */
      const evictable = [...this.entries.values()]
        .filter((e) => e.refCount === 0)
        .sort((a, b) => {
          const priorityDiff = evictionPriority(b.weight) - evictionPriority(a.weight);
          if (priorityDiff !== 0) return priorityDiff;
          return a.lastUsed - b.lastUsed;
        });
      const victim = evictable[0];
      if (!victim) {
        /* Нет evictable — все pinned. Пробуем продолжить (loadFn → LM Studio OOM → recovery). */
        return;
      }
      let evicted = false;
      await this.keyedMutex.runExclusive(victim.modelKey, async () => {
        const cur = this.entries.get(victim.modelKey);
        /* Re-check под lock: refCount мог увеличиться. Если pinned — пропускаем. */
        if (!cur || cur.refCount > 0) return;
        try {
          await this.unloadFn(cur.identifier);
        } catch (e) {
          console.warn(`[model-pool] makeRoom: unload(${cur.modelKey}) failed`, e);
          /* Если unload упал — всё равно убираем из учёта чтобы не зациклиться. */
        }
        this.entries.delete(cur.modelKey);
        evicted = true;
      });
      if (!evicted) {
        /* Жертва успела стать pinned — попробуем следующего кандидата на след. итерации. */
        continue;
      }
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
        weight: classifyByVramMB(vramMB),
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
