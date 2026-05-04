import type { BookCatalogMeta } from "./types.js";

export interface ImportResult {
  /** "added" -- новая книга. "duplicate" -- уже была (SHA совпал). "skipped" -- неподдерживаемый формат. "failed" -- ошибка парсинга. */
  outcome: "added" | "duplicate" | "skipped" | "failed";
  bookId?: string;
  meta?: BookCatalogMeta;
  warnings: string[];
  /** Текст ошибки если outcome='failed'. */
  error?: string;
  /** Имя архива-источника, если книга пришла из распаковки. */
  sourceArchive?: string;
  /** Расшифровка причины duplicate для UI. */
  duplicateReason?: "duplicate_sha" | "duplicate_isbn" | "duplicate_older_revision";
  /** Существующая книга в каталоге, из-за которой текущая была пропущена. */
  existingBookId?: string;
  existingBookTitle?: string;
}

export interface ImportFolderOptions {
  /** Если true -- сканировать архивы (zip/cbz/rar/7z/cbr) и распаковывать. */
  scanArchives?: boolean;
  /** OCR-флаг для PDF (медленно). По умолчанию false. */
  ocrEnabled?: boolean;
  /** Import root folder (для определения Sphere из первого сегмента пути). */
  importRoot?: string;
  /**
   * Макс. глубина вложенности относительно `folderPath` (см. file-walker).
   * По умолчанию 16. Для «только три уровня папок» передай 3.
   */
  maxDepth?: number;
  /**
   * Опциональный потолок числа обнаруженных книг-задач (для стресс-/smoke-тестов).
   * После достижения лимита обход останавливается; часть папки может остаться не прочитанной.
   */
  maxDiscovered?: number;
  /** Прерывание (например, юзер нажал Stop). */
  signal?: AbortSignal;
  /** Колбэк прогресса: вызывается после каждого файла. */
  onProgress?: (event: ProgressEvent) => void;
  /** Колбэк после успешного импорта -- evaluator-queue его подхватывает. */
  onBookImported?: (meta: BookCatalogMeta) => void;
  /**
   * OCR-провайдер для DJVU и сканированных PDF. Default "auto":
   * vision-llm (LM Studio) → system → none, fallback chain.
   */
  djvuOcrProvider?: "auto" | "system" | "vision-llm" | "none";
  /** Хинты OCR-языков ("uk", "en", "ru"). Первый — primary для Windows OCR. */
  ocrLanguages?: string[];
  /** Точность OS-OCR (default "accurate"). */
  ocrAccuracy?: "fast" | "accurate";
  /** DPI растеризации страниц PDF перед OCR (default 400). */
  ocrPdfDpi?: number;
  /** DPI рендера страниц DJVU (default 400). */
  djvuRenderDpi?: number;
  /** Включить Vision LLM extraction метаданных из обложки (через LM Studio). */
  visionMetaEnabled?: boolean;
  /** Включить онлайн lookup метаданных по ISBN (Open Library / Google Books). Default true. */
  metadataOnlineLookup?: boolean;
  /** Override modelKey vision-модели в LM Studio. Пусто = автодетект. */
  visionModelKey?: string;
  /**
   * Колбэк vision-meta событий — для логирования в IPC слой.
   * Импорт каждой книги может вызвать start/success/failed.
   */
  onVisionMetaEvent?: (event: { phase: "start" | "success" | "failed"; bookFile: string; message?: string; durationMs?: number; meta?: unknown }) => void;
}

/**
 * Прогресс импорта. Streaming-friendly: scanner и parser работают параллельно,
 * поэтому событий два типа.
 *
 *  - `phase: "discovered"` — scanner нашёл ещё одну книгу, парсер ещё не
 *    подходил. `discovered` нарастает; `processed`/`outcome`/`currentFile`
 *    отсутствуют. Таких событий = ровно столько, сколько файлов в папке.
 *  - `phase: "file-start"` — parser pool взял конкретный файл в работу.
 *    Это критично для больших/битых PDF/DJVU: UI показывает, какой файл
 *    сейчас может висеть до per-file timeout.
 *  - `phase: "scan-complete"` — обход FS завершён; `discovered` финально.
 *  - `phase: "processed"` — конкретный файл обработан (added/duplicate/...).
 *    Содержит `currentFile`, `outcome` и накопленные счётчики.
 *
 * Backward-compat поля `index` и `total`: дублируют `processed`/`discovered`,
 * чтобы старый UI-код не падал. Для новых интеграций — читать `phase`.
 */
export type ProgressEventPhase = "started" | "discovered" | "file-start" | "processed" | "scan-complete";

export interface ProgressEvent {
  phase: ProgressEventPhase;
  /** Сколько файлов уже найдено сканером (нарастает). */
  discovered: number;
  /** Сколько файлов уже прошли через парсер (≤ discovered). */
  processed: number;
  /** Для phase="file-start" и phase="processed". */
  currentFile?: string;
  outcome?: ImportResult["outcome"];
  duplicateReason?: ImportResult["duplicateReason"];
  existingBookId?: string;
  existingBookTitle?: string;
  /**
   * Текст ошибки или предупреждения для UI/лога. Заполняется когда
   * outcome === "failed" (тогда это error) или когда у успешного файла
   * есть warnings (например, OCR fallback) — тогда это первая warning.
   */
  errorMessage?: string;
  /** Все warnings конкретно этого файла, пробрасываются в UI лог. */
  fileWarnings?: string[];
  /** Backward-compat: старый UI читает index/total. */
  index: number;
  total: number;
}

export interface ImportFolderResult {
  total: number;
  added: number;
  duplicate: number;
  skipped: number;
  failed: number;
  warnings: string[];
}
