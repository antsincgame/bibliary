/**
 * Library catalog types — Pre-flight Evaluation architecture.
 *
 * Каждая книга хранится в `data/library/{slug}/` как два файла:
 *   1. `original.{ext}` -- нетронутая копия исходника
 *   2. `book.md`        -- единый Markdown с YAML frontmatter, текстом,
 *                          опциональной секцией `## Evaluator Reasoning`
 *                          и Base64 image-references в самом конце
 *
 * SQLite-кэш можно удалить -- при следующем старте приложение
 * пересканирует library/ и восстановит каталог из YAML frontmatter'ов.
 *
 * UI оперирует английскими зеркалами titleEn/authorEn (заполняются эвалюатором).
 * Rich bibliographic fields (year, isbn, publisher) were added for deduplication.
 */

/** Lifecycle статуса книги в библиотеке. */
export type BookStatus =
  | "imported"      // распарсено и сохранено, ждёт эвалюатора
  | "evaluating"    // эвалюатор работает прямо сейчас
  | "evaluated"     // получены qualityScore + domain + tags
  | "crystallizing" // кристаллизация в процессе
  | "indexed"       // концепты приняты в Qdrant
  | "failed"        // парсер или эвалюатор упали
  | "unsupported";  // парсер не смог собрать ни одной главы

/** Поддерживаемые форматы книг. */
export type SupportedBookFormat =
  | "pdf" | "epub" | "fb2" | "txt" | "docx" | "djvu"
  | "doc" | "rtf" | "odt" | "html" | "htm";

/** Canonical set — single source of truth for book extensions across the pipeline. */
export const SUPPORTED_BOOK_EXTS: ReadonlySet<SupportedBookFormat> = new Set([
  "pdf", "epub", "fb2", "txt", "docx", "djvu",
  "doc", "rtf", "odt", "html", "htm",
]);

/** Метаданные книги: попадают и в YAML frontmatter, и в SQLite-кэш. */
export interface BookCatalogMeta {
  // ── identity ──
  /**
   * Slug = первые 16 hex SHA-256 от **содержимого** файла. Стабилен на любой
   * машине: одинаковый файл → одинаковый id. Это даёт идемпотентность импорта,
   * портативность папки `data/library/` и невозможность дублирования в кэше.
   */
  id: string;
  /** SHA-256 от содержимого файла (для дедупликации одинаковых книг). */
  sha256: string;
  // ── source ──
  /** Имя оригинального файла (без пути), напр. `book.pdf`. */
  originalFile: string;
  originalFormat: SupportedBookFormat;
  /** Если книга извлечена из архива -- имя архива для трассировки. */
  sourceArchive?: string;
  /** Sphere — корневая папка домена из import root (напр. "Mathematics"). */
  sphere?: string;
  // ── bibliographic (original-language verbatim, English mirror for UI) ──
  /** Заголовок как пришёл от парсера (исходный язык). */
  title: string;
  /** Автор как пришёл от парсера (исходный язык). */
  author?: string;
  /** Английский заголовок от эвалюатора (translit/translate). UI primary. */
  titleEn?: string;
  /** Английская транслитерация автора от эвалюатора. UI primary. */
  authorEn?: string;
  // ── bibliographic (for dedup/enrichment) ──
  /** Publication year (from parser metadata, filename, or enrichment). */
  year?: number;
  /** ISBN-13 (normalized, digits only) or ISBN-10 if 13 not available. */
  isbn?: string;
  /** Publisher name from file metadata. */
  publisher?: string;
  // ── structure ──
  wordCount: number;
  chapterCount: number;
  // ── evaluator outputs (English) ──
  /** Узкая научная/профессиональная область. */
  domain?: string;
  /** Английские ключевые слова (макс 5). */
  tags?: string[];
  /** 0..100 -- интегральная оценка концептуальной ценности. */
  qualityScore?: number;
  /** 0..100 -- плотность определений и абстрактных моделей. */
  conceptualDensity?: number;
  /** 0..100 -- оригинальность авторских идей. */
  originality?: number;
  /** Художественная литература / мотивационная "вода" / эзотерика. */
  isFictionOrWater?: boolean;
  /** Короткое резюме вердикта (2-3 предложения, английский). */
  verdictReason?: string;
  /** Полный <think> блок эвалюатора (premium dataset asset). */
  evaluatorReasoning?: string;
  /** Идентификатор LLM, который ставил оценку. */
  evaluatorModel?: string;
  /** ISO-8601 timestamp оценки. */
  evaluatedAt?: string;
  // ── crystallization outputs ──
  conceptsExtracted?: number;
  conceptsAccepted?: number;
  // ── lifecycle ──
  status: BookStatus;
  /** Last runtime failure, shown in Catalog to explain `failed` status. */
  lastError?: string;
  /** Список warnings от парсера/эвалюатора. */
  warnings?: string[];
}

/** Одна картинка, извлечённая из книги. */
export interface ImageRef {
  /** Reference id для Markdown, напр. `img-cover`, `img-001`. */
  id: string;
  /** MIME-тип, напр. `image/jpeg`. */
  mimeType: string;
  /** Сырые байты картинки. */
  buffer: Buffer;
  /** Опциональная подпись/alt-text (если удалось извлечь). */
  caption?: string;
  /** CAS asset URL (bibliary-asset://sha256/...). Заполняется при сохранении в CAS. */
  assetUrl?: string;
}

/** Одна глава книги, как она пойдёт в .md. */
export interface ConvertedChapter {
  index: number;
  title: string;
  /** Параграфы главы (plain text). */
  paragraphs: string[];
  wordCount: number;
}

/** Полный результат конвертации книги в Markdown. */
export interface ConvertedBook {
  meta: BookCatalogMeta;
  chapters: ConvertedChapter[];
  images: ImageRef[];
  /** Готовый текст book.md (frontmatter + body + image refs). */
  markdown: string;
}

/** Параметры конвертации. */
export interface ConvertOptions {
  /** Включить OCR для сканированных PDF (медленно, но восстанавливает текст). */
  ocrEnabled?: boolean;
  /** Прерывание долгих операций. */
  signal?: AbortSignal;
  /** Hard cap на размер картинки в байтах. По умолчанию 5 MB. */
  maxImageBytes?: number;
  /** Hard cap на число картинок. По умолчанию 100. */
  maxImagesPerBook?: number;
  /**
   * Уже посчитанный SHA-256 файла (hex). Если передан, конвертер не считает
   * его повторно — экономит чтение файла на этапе ingest, где caller уже
   * посчитал хэш потоково для дедупликации до парсинга.
   */
  precomputedSha256?: string;
  /**
   * OCR-провайдер для DJVU. Передаётся в parseBook. Default "system".
   * "vision-llm" использует локальную vision-модель LM Studio.
   */
  djvuOcrProvider?: "system" | "vision-llm" | "none";
  /** Хинты языков для OCR ("uk", "en", "ru"). Первый — primary. */
  ocrLanguages?: string[];
  /**
   * Включить Vision-meta: после извлечения обложки отправить её в локальную
   * vision-модель LM Studio (qwen3-vl, llava, pixtral, gemma-3, minicpm-v и т.д.)
   * и получить title/author/year/language. Заметно улучшает качество для
   * PDF/DJVU без metadata. Если в LM Studio нет vision-модели — graceful skip.
   */
  visionMetaEnabled?: boolean;
  /** Override modelKey vision-модели. Пусто = автодетект среди загруженных. */
  visionModelKey?: string;
  /** Логгер для отчёта о прогрессе vision-meta вызова. */
  onVisionMetaEvent?: (event: { phase: "start" | "success" | "failed"; message?: string; durationMs?: number; meta?: unknown }) => void;
  /**
   * Включить онлайн-поиск метаданных по ISBN через Open Library и Google Books.
   * Выполняется после извлечения ISBN из текста книги.
   * Не влияет на vision-meta; оба механизма независимы.
   * Default: true (пользователь может отключить в настройках).
   */
  metadataOnlineLookup?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight Evaluator types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON-ответ Главного Эпистемолога после анализа Structural Surrogate.
 * Все поля -- на английском по контракту: эвалюатор переводит/транслитерирует.
 */
export interface BookEvaluation {
  title_en: string;
  author_en: string;
  year: number | null;
  domain: string;
  tags: string[];
  is_fiction_or_water: boolean;
  conceptual_density: number;   // 0..100
  originality: number;          // 0..100
  quality_score: number;        // 0..100
  verdict_reason: string;
}

/** Результат прогона книги через эвалюатор. */
export interface EvaluationResult {
  evaluation: BookEvaluation | null;
  /** Содержимое <think>...</think> блока, trimmed. */
  reasoning: string | null;
  /** Сырой ответ модели (для дебага и сохранения). */
  raw: string;
  /** Идентификатор модели, который ставил оценку. */
  model: string;
  /** Предупреждения парсера (malformed JSON, missing fields и т.п.). */
  warnings: string[];
}

/**
 * Структурный суррогат книги: оглавление + интро + исход + узловые срезы.
 * Передаётся в LLM-эпистемолог вместо полного текста (≈4K слов).
 */
export interface SurrogateDocument {
  /** Готовый текст для LLM (с заголовками секций). */
  surrogate: string;
  /** Метаданные сборки -- для логов и тестов. */
  composition: {
    tocChapters: number;
    introWords: number;
    outroWords: number;
    nodalSlices: { chapter: string; paragraphs: number; words: number }[];
    totalWords: number;
  };
}
