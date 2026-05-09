/**
 * PreferencesStore -- user-tunable constants backed by data/preferences.json.
 *
 * Pattern: same as ProfileStore (Zod schema, atomic write, lockfile, singleton).
 * Every constant has a sensible default; the file only stores overrides.
 * Settings UI always shows all sections (mode-switcher removed in Иt 8Б).
 */

import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";

import { writeJsonAtomic, withFileLock } from "../resilience";

// ---------------------------------------------------------------------------
// Schema -- every field is optional (missing = use default)
// ---------------------------------------------------------------------------

export const PreferencesSchema = z.object({
  // -- vectordb search threshold (cosine score 0..1) --
  searchScoreThreshold: z.number().min(0).max(1).default(0.55),

  // -- Scanner / Ingest --
  ingestParallelism: z.number().int().min(1).max(16).default(3),
  ingestUpsertBatch: z.number().int().min(1).max(256).default(32),
  maxBookChars: z.number().int().min(100_000).max(50_000_000).default(5_000_000),

  // -- Semantic Chunker (Crystal) --
  chunkSafeLimit: z.number().int().min(500).max(20_000).default(4000),
  chunkMinWords: z.number().int().min(50).max(2000).default(300),
  driftThreshold: z.number().min(0).max(1).default(0.45),
  maxParagraphsForDrift: z.number().int().min(100).max(5000).default(800),
  overlapParagraphs: z.number().int().min(0).max(10).default(1),
  /**
   * Кастомный промпт для семантического чанкера — пользователь описывает,
   * как именно резать книгу на смысловые части (например: «Резать по
   * главам, оставляя в каждом чанке тематически связные параграфы»).
   * Пусто = используется встроенный промпт. Применяется в дополнение к
   * chunkSafeLimit/chunkMinWords как hint для drift detection.
   */
  chunkerCustomPrompt: z.string().max(2000).default(""),

  // -- Resilience / Timeouts --
  policyMaxRetries: z.number().int().min(0).max(20).default(3),
  policyBaseBackoffMs: z.number().int().min(100).max(30_000).default(1000),
  hardTimeoutCapMs: z.number().int().min(30_000).max(3_600_000).default(600_000),

  // -- Resilience / File locks (Phase 2.5R) --
  lockRetries: z.number().int().min(0).max(20).default(5),
  lockStaleMs: z.number().int().min(1_000).max(60_000).default(10_000),

  // -- Resilience / LM Studio watchdog (Phase 2.5R) --
  healthPollIntervalMs: z.number().int().min(1_000).max(60_000).default(5_000),
  healthFailThreshold: z.number().int().min(1).max(20).default(3),
  watchdogLivenessTimeoutMs: z.number().int().min(500).max(15_000).default(3_000),

  // -- BookHunter --
  searchPerSourceLimit: z.number().int().min(1).max(50).default(20),
  downloadMaxRetries: z.number().int().min(1).max(10).default(3),

  // -- Vector DB (in-process LanceDB) --
  /** Сколько результатов выводить в search UI. Не влияет на upsert/queryNearest
   * самой LanceDB — только на размер списка в renderer'е. */
  vectordbSearchLimit: z.number().int().min(1).max(100).default(12),

  // -- UI --
  /* refreshIntervalMs / toastTtlMs / spinDurationMs удалены 2026-05-01:
     ни один production-читатель не использовал их (Models page жёстко
     задаёт REFRESH_MS=8000, TOAST_TTL_MS=5000 в models-page-internals.js;
     спиннеры — через CSS-анимации). См. план library-fortress, Иt 8А. */
  resilienceBarHideDelayMs: z.number().int().min(1000).max(30_000).default(4000),

  // -- OCR (Phase 6.0, OS-native via @napi-rs/system-ocr + LM Studio vision) --
  /**
   * Default ON. OCR применяется автоматически когда у книги нет текстового слоя
   * (сканированные PDF, DJVU без OCR'a). Безвредно для книг с текстом — там
   * парсер вытаскивает текст напрямую, OCR не вызывается.
   */
  ocrEnabled: z.boolean().default(true),
  /**
   * Языки распознавания. Default: ru, uk, en. Первый — primary для Windows OCR
   * (Windows.Media.Ocr берёт только первый язык). Порядок: Cyrillic-first,
   * потому что Bibliary — в первую очередь Русскоязычная/Украиноязычная библиотека.
   * Остальные — для vision-LLM пути и для Tesseract где он используется.
   */
  ocrLanguages: z.array(z.string().min(2).max(10)).max(8).default(["ru", "uk", "en"]),
  ocrAccuracy: z.enum(["fast", "accurate"]).default("accurate"),
  /**
   * DPI растеризации страниц PDF перед OCR. Default 400 — высокое качество
   * для тонкого текста и формул. Для очень больших книг (>1000 страниц)
   * можно понизить до 200, чтобы ускорить.
   */
  ocrPdfDpi: z.number().int().min(100).max(600).default(400),
  /**
   * Провайдер OCR для DJVU и сканированных PDF.
   *   - "auto" (default): сначала пытаемся через локальную vision-модель LM Studio
   *     (роль vision_ocr из настроек "Модели"), при провале — системный OCR
   *     (Windows.Media.Ocr / macOS Vision Framework), при его недоступности — none.
   *     Это режим "лучшее качество с автоматическим fallback".
   *   - "vision-llm": ТОЛЬКО локальный LM Studio (vision_ocr роль).
   *   - "system": ТОЛЬКО системный OS OCR.
   *   - "none": OCR полностью отключён для DJVU/PDF-сканов.
   */
  djvuOcrProvider: z.enum(["auto", "system", "vision-llm", "none"]).default("auto"),
  djvuRenderDpi: z.number().int().min(100).max(600).default(400),
  /** Hard limit для размера DJVU файла (MB). Default 500 MB; архивные тома
   * (Britannica, БСЭ) часто 800-2000 MB — поднять для них. Min 50, max 4096 MB. */
  djvuMaxFileSizeMb: z.number().int().min(50).max(4096).default(500),

  // -- Metadata online lookup (ISBN → Open Library / Google Books) --
  /**
   * Включить онлайн-lookup метаданных по ISBN через Open Library и Google Books.
   * Требует интернет. Выполняется после парсинга файла, до vision-meta.
   * Default true.
   */
  metadataOnlineLookup: z.boolean().default(true),

  // -- Marker sidecar (Phase 7: layout-aware PDF/DJVU extraction) --
  /**
   * Использовать Marker (WSL Python sidecar) для извлечения figures/таблиц
   * из PDF и DJVU. Marker умеет layout detection, Surya OCR, Texify (LaTeX).
   * Требует WSL2 + установленный marker-pdf (scripts/bootstrap-marker.ps1).
   * ENV BIBLIARY_USE_MARKER=1 переопределяет это значение.
   * Default false — встроенный pdfjs/ddjvu extractor.
   */
  useMarkerExtractor: z.boolean().default(false),

  // -- Library UI --
  libraryGroupBy: z.enum(["none", "ext", "status", "folder"]).default("none"),

  // -- Connectivity (external service URLs) --
  /** Empty string = use env var or built-in default. Validation: no trailing slash. */
  lmStudioUrl: z.string().regex(/^$|^https?:\/\/[^\s/$.?#].[^\s]*[^/]$/i, "must be a URL without trailing slash, or empty for default").default(""),

  // -- Selected models per task (упрощено с 9 ролей до 3 задач, 2026-05) --
  /**
   * Reader model — small fast LLM для evaluation книг и других light tasks.
   * Рекомендация: 3-7B instruct-tuned, например Qwen2.5-3B / Llama-3-8B.
   * Пусто = fallback на первую загруженную модель в LM Studio.
   */
  readerModel: z.string().default(""),
  /**
   * Extractor model — big reasoning LLM для concept extraction (datasets).
   * Рекомендация: 14B+ reasoning-tuned (Qwen3-14B-Thinking, GLM-4.7-Air-Reasoning).
   * Пусто = fallback на первую загруженную модель.
   */
  extractorModel: z.string().default(""),
  /**
   * Vision OCR model — optional vision-capable LLM для OCR DJVU/PDF без
   * text-layer (когда `djvuOcrProvider === "vision-llm"`).
   * Рекомендация: Qwen2.5-VL-7B+ или подобная multimodal модель.
   * Пусто = system OCR (Win.Media.Ocr / macOS Vision Framework).
   */
  visionOcrModel: z.string().default(""),

  // ==========================================================================
  // Smart Import Pipeline (Иt 8Б library-fortress, 2026-05-01)
  //
  // Все ключи ниже до Иt 8Б были hardcoded константами или env-only. Теперь
  // — Settings = single source of truth (см. plan: library_fortress_phalanx).
  // applyRuntimeSideEffects распространяет изменения на живые singletons.
  // ==========================================================================

  // -- ImportTaskScheduler lanes (per Perplexity research: semaphore + token bucket) --
  /** Параллелизм light-lane (мелкие LLM-задачи ≤8 GB). Default 8. */
  schedulerLightConcurrency: z.number().int().min(1).max(32).default(8),
  /** Параллелизм medium-lane (8..16 GB модели: evaluator). Default 3. */
  schedulerMediumConcurrency: z.number().int().min(1).max(8).default(3),
  /** Параллелизм heavy-lane (>16 GB / vision: illustration, vision-ocr, ddjvu→PDF). Default 1. */
  schedulerHeavyConcurrency: z.number().int().min(1).max(4).default(1),

  /**
   * Adaptive scheduling — авто-подстройка concurrency через AIMD при импорте.
   * Использует latency feedback и memory pressure (RAM/VRAM/RSS) для урезания
   * heavy/medium lane при перегрузке. Включена по умолчанию для защиты крепости.
   * Phalanx Risk Mitigation: minConcurrency=1 жёстко, GC try, soft decrease.
   */
  adaptiveSchedulingEnabled: z.boolean().default(true),

  // -- Parser pool (CPU-bound, отдельно от scheduler) --
  /**
   * Размер parser pool в import.ts. 0 = auto (CPU-1, max 4 — защита от heap fragmentation
   * при многочасовом импорте DJVU). >0 = явный override.
   * Иt 8В.CRITICAL.2: env BIBLIARY_PARSER_POOL_SIZE удалён — Settings = SSoT.
   */
  parserPoolSize: z.number().int().min(0).max(16).default(0),

  // -- Evaluator queue --
  /** Сколько evaluator слотов одновременно. Default 2 (баланс RAM/throughput). */
  evaluatorSlots: z.number().int().min(1).max(8).default(2),

  // -- Heavy lane rate limiter (vision-OCR DDoS protection) --
  /**
   * Лимит запросов в минуту к vision-OCR модели per-modelKey.
   * Книга в 1000 страниц без текста = 1000 vision запросов; rpm 60 = 1/sec.
   * Иt 8В.CRITICAL.2: env BIBLIARY_VISION_OCR_RPM удалён — Settings = SSoT.
   */
  visionOcrRpm: z.number().int().min(1).max(600).default(60),

  // -- Illustration worker --
  // -- Converter cache --
  /**
   * Максимальный размер converter cache (data/converters-cache/) в байтах.
   * 0 = без лимита. Default 5 GB (соответствует DEFAULT_MAX_BYTES в cache.ts).
   * LRU eviction при превышении.
   * Иt 8В.CRITICAL.2: env BIBLIARY_CONVERTER_CACHE_MAX_BYTES удалён — Settings = SSoT.
   */
  converterCacheMaxBytes: z.number().int().min(0).default(5 * 1024 * 1024 * 1024),

  // -- Cross-format dedup tuning --
  /**
   * Если true — при наличии и DjVu, и PDF одной книги, выбираем DjVu (меньше,
   * есть OCR-слой от FineReader). По умолчанию false: PDF приоритетнее (текст
   * чище). Roadmap пункт из docs/smart-import-pipeline.md v0.8.0.
   */
  preferDjvuOverPdf: z.boolean().default(false),

  // -- Uniqueness Evaluator (per-chapter idea novelty against vectordb corpus) --
  /**
   * Включить uniqueness-eval после quality-eval. Проходит по всем главам книги,
   * извлекает 3-7 идей на главу через reader LLM, дедуплицирует внутри книги,
   * сравнивает с существующей коллекцией vectordb. Стоит ~1-3 минуты на книгу
   * (50 глав × 2с reader). Можно выключить если важна скорость.
   */
  uniquenessEvaluationEnabled: z.boolean().default(true),
  /**
   * Cosine similarity ≥ этого порога ⇒ идея считается DERIVATIVE без LLM-judge.
   * Default 0.85 — баланс между recall и precision на e5-small эмбеддингах.
   *
   * **Origin & calibration**: 0.85 / 0.65 / 0.92 — стартовые значения из
   * pilot-runs на ~30 книгах смешанного домена (CS / phys / hist) с manual
   * spot-check. Не рекомендуется без re-tuning менять для других corpus
   * profiles (узко-доменные библиотеки → возможно нужно поднять threshold,
   * иначе "everything looks similar"). TODO: добавить evaluation-set с
   * labelled novel/derivative парами для empirical validation.
   */
  uniquenessSimilarityHigh: z.number().min(0.5).max(1).default(0.85),
  /**
   * Cosine similarity < этого порога ⇒ идея NOVEL без LLM-judge.
   * Между low и high — серая зона, отдаётся reader LLM на verdict.
   * Default 0.65 — см. calibration-комментарий на uniquenessSimilarityHigh.
   */
  uniquenessSimilarityLow: z.number().min(0).max(0.95).default(0.65),
  /** Hard cap на число идей, извлекаемых из одной главы. */
  uniquenessIdeasPerChapterMax: z.number().int().min(2).max(15).default(7),
  /**
   * Сколько глав обрабатывать параллельно (async-ready). Реальная concurrency
   * = min(этот pref, GPU slots в LM Studio). На single-GPU LM Studio (типичный
   * случай) запросы сериализуются в любом случае — больше 2-3 не даёт прироста.
   */
  uniquenessChapterParallel: z.number().int().min(1).max(8).default(2),
  /**
   * Within-book dedup: cosine ≥ этого ⇒ идеи в один кластер.
   * Default 0.92 — only near-paraphrases collapse, distinct facts stay separate.
   * Tuned на той же ~30-book pilot выборке что и similarityHigh/Low. Поднимать
   * (например 0.95) если кластеры сливают семантически разные claims.
   */
  uniquenessMergeThreshold: z.number().min(0.7).max(1).default(0.92),
  /**
   * Имя коллекции, против которой uniqueness evaluator проверяет novelty.
   * Пусто = fallback на dataset-v2 DEFAULT_COLLECTION (default ingest target).
   * Если пользователь использует кастомную коллекцию для extraction,
   * сюда нужно прописать то же имя — иначе uniqueness считает novelty
   * против чужого корпуса и score становится бессмысленным.
   */
  uniquenessTargetCollection: z.string().default(""),
  /** Включить concept-level dedup на этапе ingest (skip upsert если совпадение в коллекции). */
  conceptDedupEnabled: z.boolean().default(true),
  /**
   * Отдельный (более строгий) порог для ingest-dedup: cosine ≥ этого ⇒ skip
   * upsert. Выше чем uniquenessSimilarityHigh, потому что на ingest нет
   * LLM-fallback'а в серой зоне (слишком дорого), компенсируем precision'ом.
   * Default 0.93 — отсекаем только почти-точные дубликаты, не «та же тема».
   */
  conceptDedupSimilarityThreshold: z.number().min(0.8).max(1).default(0.93),

  // -- Onboarding wizard (Phase 3) --
  /** True если пользователь прошёл/skip-нул welcome wizard. Заменяет legacy localStorage. */
  onboardingDone: z.boolean().default(false),
  /** Версия пройденного wizard. Позволяет показать wizard повторно при major update. */
  onboardingVersion: z.number().int().min(0).max(1000).default(0),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULTS: Preferences = PreferencesSchema.parse({});

export const PreferencesFileSchema = z.object({
  version: z.literal(1),
  prefs: PreferencesSchema.partial(),
});

export type PreferencesFile = z.infer<typeof PreferencesFileSchema>;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Уведомление о повреждённом preferences.json — приёмники могут показать
 * пользователю warning toast вместо тихого reset настроек к defaults.
 *
 * Заполняется при корраптед-ситуации (неparsable JSON / Zod schema fail).
 * Хранится в global state модуля — тонкий канал между store ↔ UI без
 * введения зависимости от Electron BrowserWindow.
 */
export interface PrefsCorruptionEvent {
  /** Имя файла бэкапа (`preferences.json.corrupted-1714...`). Null если backup не удался. */
  backupPath: string | null;
  /** Текст ошибки парсинга/валидации. */
  reason: string;
  /** UNIX ms когда произошло. */
  detectedAt: number;
}

let lastCorruption: PrefsCorruptionEvent | null = null;

/** Возвращает (и очищает) последнее событие повреждения prefs. UI читает раз. */
export function takePrefsCorruptionEvent(): PrefsCorruptionEvent | null {
  const ev = lastCorruption;
  lastCorruption = null;
  return ev;
}

export class FsPreferencesStore {
  private readonly file: string;
  private cache: PreferencesFile | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "preferences.json");
  }

  async ensureDefaults(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, "utf8");
      if (raw.trim()) {
        /* C5 fix (2026-05-04, /imperor): проверяем валидность ДО return, чтобы
         * corrupted JSON не оставался лежать как «существующий» файл — иначе
         * следующий readOverrides тихо отдаст {} и юзер потеряет настройки
         * без следа. Если corrupted — переименовываем в .corrupted-<ts> и
         * пересоздаём preferences.json с дефолтами + сигналим UI. */
        try {
          PreferencesFileSchema.parse(JSON.parse(raw));
          return; /* всё ок */
        } catch (parseErr) {
          await this.quarantineCorruptedFile(parseErr);
          /* Дальше — fall-through к writeJsonAtomic с дефолтами. */
        }
      }
    } catch { /* ENOENT */ }
    await writeJsonAtomic(this.file, { version: 1 as const, prefs: {} });
  }

  /**
   * Iter 14.4 (C5 fix): повреждённый preferences.json не молчит — мы
   * переименовываем его в `.corrupted-<ts>` (для пост-mortem анализа
   * и возможного ручного восстановления пользователем) и сигнализируем
   * UI через takePrefsCorruptionEvent().
   */
  private async quarantineCorruptedFile(reason: unknown): Promise<void> {
    const ts = Date.now();
    const backupPath = `${this.file}.corrupted-${ts}`;
    let actualBackup: string | null = null;
    try {
      await fs.rename(this.file, backupPath);
      actualBackup = backupPath;
      console.error(
        `[preferences/store] corrupted preferences.json detected, quarantined to ${backupPath}.\n` +
        `  Reason: ${reason instanceof Error ? reason.message : String(reason)}\n` +
        `  Defaults restored. Original kept for manual recovery.`,
      );
    } catch (renameErr) {
      console.error(
        `[preferences/store] FAILED to quarantine corrupted preferences.json:`,
        renameErr,
        `\n  Original error:`, reason,
      );
    }
    lastCorruption = {
      backupPath: actualBackup,
      reason: reason instanceof Error ? reason.message : String(reason),
      detectedAt: ts,
    };
  }

  async getAll(): Promise<Preferences> {
    const overrides = await this.readOverrides();
    const merged = { ...DEFAULTS, ...overrides } as Preferences & Record<string, unknown>;

    /* Migration shim (refactor 1.0.22): legacy keys → new keys. Применяется
     * только если новый key пуст, чтобы пользовательский явный выбор
     * не перетирался. Старые keys валидируются Zod как unknown — игнорируются. */
    const legacy = merged as Record<string, unknown>;
    if (!merged.readerModel && typeof legacy.evaluatorModel === "string") {
      merged.readerModel = String(legacy.evaluatorModel);
    }
    if (!merged.visionOcrModel && typeof legacy.visionModelKey === "string") {
      merged.visionOcrModel = String(legacy.visionModelKey);
    }
    /* Migration shim (Phase 4 vectordb): legacy chroma* → vectordb* equivalent
     * + drop fully-deprecated keys. Read-only — pruning старых ключей из
     * persisted prefs.json произойдёт при следующем set() автоматически
     * (PreferencesSchema.partial() отбросит unknown keys). */
    if (typeof legacy.chromaSearchLimit === "number" && merged.vectordbSearchLimit === DEFAULTS.vectordbSearchLimit) {
      merged.vectordbSearchLimit = legacy.chromaSearchLimit as number;
    }

    return merged as Preferences;
  }

  async get<K extends keyof Preferences>(key: K): Promise<Preferences[K]> {
    const all = await this.getAll();
    return all[key];
  }

  async set(partial: Partial<Preferences>): Promise<Preferences> {
    await withFileLock(this.file, async () => {
      const overrides = await this.readOverrides();
      const merged = { ...overrides, ...partial };
      const validated = PreferencesSchema.partial().parse(merged);
      const file: PreferencesFile = { version: 1, prefs: validated };
      await writeJsonAtomic(this.file, file);
      this.cache = file;
    });
    return this.getAll();
  }

  async reset(): Promise<Preferences> {
    await withFileLock(this.file, async () => {
      const file: PreferencesFile = { version: 1, prefs: {} };
      await writeJsonAtomic(this.file, file);
      this.cache = file;
    });
    return DEFAULTS;
  }

  invalidate(): void {
    this.cache = null;
  }

  private async readOverrides(): Promise<Partial<Preferences>> {
    if (this.cache) return this.cache.prefs;
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      /* ENOENT — файл ещё не создан, нормальное состояние при первом запуске. */
      return {};
    }
    try {
      const parsed = PreferencesFileSchema.parse(JSON.parse(raw));
      this.cache = parsed;
      return parsed.prefs;
    } catch (parseErr) {
      /* C5 fix: ошибка парсинга существующего файла — это РЕАЛЬНОЕ
       * повреждение (а не отсутствие). Карантиним и сигналим UI вместо
       * тихого reset к defaults. */
      await this.quarantineCorruptedFile(parseErr);
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: FsPreferencesStore | null = null;

export function initPreferencesStore(dataDir: string): FsPreferencesStore {
  instance = new FsPreferencesStore(dataDir);
  return instance;
}

export function getPreferencesStore(): FsPreferencesStore {
  if (!instance) throw new Error("PreferencesStore not initialised. Call initPreferencesStore() in bootstrap.");
  return instance;
}

/**
 * Lazy-friendly доступ к prefs из модулей, которые могут грузиться ДО
 * `initPreferencesStore` (тесты, ранний bootstrap). Возвращает `null` вместо
 * throw — caller выбирает свой fallback (обычно `??` на DEFAULT_*).
 *
 * Цель (Иt 8В.MEDIUM.7): убрать копипасту `try { const { getPreferencesStore } =
 * await import("..."); const prefs = await getPreferencesStore().getAll(); } catch {}`
 * из 5+ модулей пайплайна. Один статический import + одна строка вместо
 * dynamic import + try/catch блока.
 */
export async function readPipelinePrefsOrNull(): Promise<Preferences | null> {
  try {
    return await getPreferencesStore().getAll();
  } catch {
    return null;
  }
}
