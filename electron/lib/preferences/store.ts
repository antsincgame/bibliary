/**
 * PreferencesStore -- user-tunable constants backed by data/preferences.json.
 *
 * Pattern: same as ProfileStore (Zod schema, atomic write, lockfile, singleton).
 * Every constant has a sensible default; the file only stores overrides.
 * UI mode (Simple/Advanced/Pro) controls which settings are exposed, not stored.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";

import { writeJsonAtomic, withFileLock } from "../resilience";

// ---------------------------------------------------------------------------
// Schema -- every field is optional (missing = use default)
// ---------------------------------------------------------------------------

export const PreferencesSchema = z.object({
  // -- RAG --
  ragTopK: z.number().int().min(1).max(100).default(15),
  ragScoreThreshold: z.number().min(0).max(1).default(0.55),

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

  // -- Judge & Dedup --
  judgeScoreThreshold: z.number().min(0).max(1).default(0.6),
  crossLibDupeThreshold: z.number().min(0).max(1).default(0.85),
  intraDedupThreshold: z.number().min(0).max(1).default(0.88),

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

  // -- Qdrant --
  qdrantTimeoutMs: z.number().int().min(1000).max(60_000).default(8000),
  qdrantSearchLimit: z.number().int().min(1).max(100).default(12),

  // -- UI --
  refreshIntervalMs: z.number().int().min(2000).max(60_000).default(7000),
  toastTtlMs: z.number().int().min(1000).max(30_000).default(5000),
  spinDurationMs: z.number().int().min(100).max(3000).default(600),
  resilienceBarHideDelayMs: z.number().int().min(1000).max(30_000).default(4000),

  // -- OCR (Phase 6.0, OS-native via @napi-rs/system-ocr) --
  ocrEnabled: z.boolean().default(false),
  ocrLanguages: z.array(z.string().min(2).max(10)).max(8).default([]),
  ocrAccuracy: z.enum(["fast", "accurate"]).default("accurate"),
  ocrPdfDpi: z.number().int().min(100).max(400).default(200),
  djvuOcrProvider: z.enum(["system", "vision-llm", "none"]).default("system"),
  djvuRenderDpi: z.number().int().min(100).max(600).default(200),
  openrouterApiKey: z.string().max(512).default(""),

  // -- Vision-meta (локальная LM Studio multimodal модель для извлечения метаданных из обложек) --
  /** Ручной override modelKey vision-модели. Пусто = автоматический поиск среди загруженных. */
  visionModelKey: z.string().default(""),
  /**
   * Включить vision-meta (LLM-анализ обложки).
   * Default false — используется как последний резерв после parsed metadata + ISBN lookup.
   * Включайте только если у вас есть vision-capable модель в LM Studio и ISBN-lookup не помогает.
   */
  visionMetaEnabled: z.boolean().default(false),

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
  qdrantUrl: z.string().regex(/^$|^https?:\/\/[^\s/$.?#].[^\s]*[^/]$/i, "must be a URL without trailing slash, or empty for default").default(""),

  // -- Selected models per role --
  /** Модель LM Studio для extractor (Crystallizer). Пусто = первая загруженная. */
  extractorModel: z.string().default(""),
  /** Модель LM Studio для judge (Crystallizer). Пусто = extractorModel. */
  judgeModel: z.string().default(""),
  /**
   * Модель LM Studio для evaluator (book pre-flight). Пусто = pickEvaluatorModel
   * выберет лучшую автоматически (curated tags + heuristics в book-evaluator.ts).
   */
  evaluatorModel: z.string().default(""),
  // -- Per-role fallback chains (CSV modelKey1,modelKey2,...) --
  extractorModelFallbacks: z.string().default(""),
  judgeModelFallbacks: z.string().default(""),
  evaluatorModelFallbacks: z.string().default(""),
  /**
   * Legacy общий fallback для всех vision-ролей. Используется если конкретные
   * visionMetaFallbacks/visionOcrFallbacks/visionIllustrationFallbacks пустые.
   */
  visionModelFallbacks: z.string().default(""),

  // -- Vision-роли (split: meta / ocr / illustration). Каждая опционально --
  /** Модель для извлечения метаданных книги с обложки. Пусто = legacy visionModelKey. */
  visionMetaModel: z.string().default(""),
  visionMetaFallbacks: z.string().default(""),
  /** Модель для OCR сканированных страниц (DJVU/scanned PDF). Пусто = legacy visionModelKey. */
  visionOcrModel: z.string().default(""),
  visionOcrFallbacks: z.string().default(""),
  /**
   * Модель для описания иллюстраций (для индексации в Qdrant как RAG-контент).
   * Здесь важна способность писать связное тематическое описание с привязкой
   * к контексту главы. Пусто = legacy visionModelKey.
   */
  visionIllustrationModel: z.string().default(""),
  visionIllustrationFallbacks: z.string().default(""),
  /**
   * Включить CLIP-векторизацию иллюстраций для multimodal-поиска.
   * При включении: после vision-triage иллюстрация дополнительно индексируется
   * в Qdrant-коллекции `bibliary_illustrations` через CLIP image encoder
   * (Xenova/clip-vit-base-patch32, ~600MB, скачивается один раз).
   * Это даёт image-to-image и text-to-image поиск по картинкам книг.
   * Default false — экономит RAM на слабых машинах.
   */
  imageVectorIndexEnabled: z.boolean().default(false),

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

  // -- Model role resolver --
  /**
   * TTL кэша resolved role → modelKey в memory. 0 = no cache (всегда заново).
   * Default 30 секунд — баланс между производительностью и реактивностью.
   */
  modelRoleCacheTtlMs: z.number().int().min(0).default(30_000),

  // -- Onboarding wizard (Phase 3) --
  /** True если пользователь прошёл/skip-нул welcome wizard. Заменяет legacy localStorage. */
  onboardingDone: z.boolean().default(false),
  /** Версия пройденного wizard. Позволяет показать wizard повторно при major update. */
  onboardingVersion: z.number().int().min(0).max(1000).default(0),

  // -- Olympics: per-role LM Studio tuning --
  /**
   * Если true — Олимпиада грузит каждую модель с per-role load config
   * (см. electron/lib/llm/role-load-config.ts) и использует per-role
   * inference defaults (temperature/topP). Default false — старое
   * поведение (фиксированный context_length=2048, temp=0.2/0.6).
   *
   * Включай если есть VRAM ≥ 8 ГБ и нужен реалистичный замер crystallizer
   * с длинным контекстом (32K) — модели будут оценены на той длине, на
   * которой реально работают в production.
   */
  olympicsRoleLoadConfigEnabled: z.boolean().default(false),

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
      if (raw.trim()) return;
    } catch { /* ENOENT */ }
    await writeJsonAtomic(this.file, { version: 1 as const, prefs: {} });
  }

  async getAll(): Promise<Preferences> {
    const overrides = await this.readOverrides();
    return { ...DEFAULTS, ...overrides };
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
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = PreferencesFileSchema.parse(JSON.parse(raw));
      this.cache = parsed;
      return parsed.prefs;
    } catch {
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
