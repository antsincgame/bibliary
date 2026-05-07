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
  // -- Chroma search threshold (cosine score 0..1) --
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

  // -- Chroma (vector DB) --
  chromaTimeoutMs: z.number().int().min(1000).max(60_000).default(8000),
  chromaSearchLimit: z.number().int().min(1).max(100).default(12),

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

  // -- Vision-meta (локальная LM Studio multimodal модель для извлечения метаданных из обложек) --
  /** Ручной override modelKey vision-модели. Пусто = автоматический поиск среди загруженных. */
  visionModelKey: z.string().default(""),
  /**
   * Включить vision-meta (LLM-анализ обложки).
   * Default true — дополняет parsed metadata + ISBN lookup данными с обложки.
   * Требует vision-capable модель в LM Studio (llava, qwen-vl, minicpm-v и пр.).
   * Gracefully no-ops если vision-модель не загружена.
   */
  visionMetaEnabled: z.boolean().default(true),

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
  chromaUrl: z.string().regex(/^$|^https?:\/\/[^\s/$.?#].[^\s]*[^/]$/i, "must be a URL without trailing slash, or empty for default").default(""),

  // -- Selected models per role --
  /** Модель LM Studio для extractor (Crystallizer). Пусто = первая загруженная. */
  extractorModel: z.string().default(""),
  /**
   * Модель LM Studio для evaluator (book pre-flight). Пусто = pickEvaluatorModel
   * выберет лучшую автоматически (curated tags + heuristics в book-evaluator.ts).
   */
  evaluatorModel: z.string().default(""),
  /**
   * Smart-fallback для evaluator: если preferred модель не загружена в LM Studio
   * И CSV fallbacks тоже не подходят — picker возьмёт ЛЮБУЮ загруженную LLM
   * (с скорингом по эвристикам), вместо того чтобы помечать книгу `failed`.
   * Default: false — строгий режим, уважает явный выбор модели пользователем.
   * Включать только если хочешь "оценивать любой загруженной LLM когда preferred недоступна".
   */
  evaluatorAllowFallback: z.boolean().default(false),
  // -- Per-role fallback chains (CSV modelKey1,modelKey2,...) --
  extractorModelFallbacks: z.string().default(""),
  evaluatorModelFallbacks: z.string().default(""),
  /** Fallback chain для vision-ролей (CSV modelKey1,modelKey2,...). */
  visionModelFallbacks: z.string().default(""),

  // -- Language-specialist roles --
  /** Модель, которая хорошо работает с украинским (Aya, Llama-3-uk, Qwen-uk и т.п.). Пусто = не используется. */
  ukrainianSpecialistModel: z.string().default(""),
  ukrainianSpecialistModelFallbacks: z.string().default(""),
  /** Малая модель для определения языка текста (ISO-639-1). Пусто = не используется. */
  langDetectorModel: z.string().default(""),
  langDetectorModelFallbacks: z.string().default(""),
  /** Модель-переводчик: укр/любой → русский или английский. Пусто = не используется. */
  translatorModel: z.string().default(""),
  translatorModelFallbacks: z.string().default(""),
  /** Целевой язык переводчика: "ru" (default) или "en". */
  translatorTargetLang: z.enum(["ru", "en"]).default("ru"),
  /** Авто-переводить книги на украинском (и схожих языках) при ingest. */
  translateNonRussianBooks: z.boolean().default(true),

  // -- Layout Assistant (LLM пост-обработка book.md) --
  /**
   * Включить LLM-верстальщика. Когда `true` — после импорта book.md
   * прогоняется через layout-assistant queue (см. layout-assistant-queue.ts):
   * модель размечает заголовки, dot-leader ToC, удаляет OCR-junk.
   * Default `true` — включён из коробки; ручной запуск из reader доступен всегда.
   */
  layoutAssistantEnabled: z.boolean().default(true),
  /** LM Studio модель для layout_assistant роли. Пусто = первая загруженная. */
  layoutAssistantModel: z.string().default(""),
  /** CSV fallback chain для layout_assistant. */
  layoutAssistantModelFallbacks: z.string().default(""),

  // -- Model role resolver --
  /**
   * TTL кэша resolved role → modelKey в memory. 0 = no cache (всегда заново).
   * Default 30 секунд — баланс между производительностью и реактивностью.
   */
  modelRoleCacheTtlMs: z.number().int().min(0).default(30_000),

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
  /**
   * Внутренний параллелизм описания иллюстраций per-book. Default 4.
   * До Иt 8Б был hardcoded VISION_PARALLELISM в illustration-worker.ts.
   */
  illustrationParallelism: z.number().int().min(1).max(16).default(4),

  /**
   * Иt 8В.MEDIUM.10: книги, импортируемые параллельно через illustration-worker
   * (semaphore по bookId). Раньше было только env `BIBLIARY_ILLUSTRATION_PARALLEL_BOOKS`,
   * теперь Settings = single source of truth (приказ Царя об отказе от env).
   * 1 = строго последовательно (для слабых машин), 2 = default, до 16 для мощных.
   */
  illustrationParallelBooks: z.number().int().min(1).max(16).default(2),

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
    const result = { ...DEFAULTS, ...overrides };

    if (!result.visionModelKey) {
      result.visionModelKey = await this.migrateLegacyVisionKey();
    }

    return result;
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

  /**
   * Migration: read legacy split vision pref keys from raw JSON (bypassing Zod)
   * and return the first non-empty one as the unified visionModelKey.
   */
  private async migrateLegacyVisionKey(): Promise<string> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const json = JSON.parse(raw) as { prefs?: Record<string, unknown> };
      const p = json?.prefs ?? {};
      return String(p.visionIllustrationModel || p.visionMetaModel || p.visionOcrModel || "");
    } catch {
      return "";
    }
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
