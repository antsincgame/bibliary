/**
 * Контракт парсеров книг. Все парсеры возвращают единую структуру:
 * иерархия секций → параграфы. Дальнейшая логика (chunker, embedder)
 * не знает о формате источника.
 */

export interface BookSection {
  /** 1 = глава (chapter), 2 = раздел (section), 3 = подраздел (subsection). */
  level: 1 | 2 | 3;
  title: string;
  /** Готовые к чтению параграфы — пустые строки и whitespace-only выкинуты. */
  paragraphs: string[];
}

export interface BookMetadata {
  title: string;
  author?: string;
  language?: string;
  /** ISBN/ASIN/UUID если найден. */
  identifier?: string;
  /** Год публикации, если можно достоверно извлечь. */
  year?: number;
  /** Publisher name from file metadata (OPF dc:publisher, FB2 publish-info, PDF info). */
  publisher?: string;
  /** Кодировка/декодинг warnings для отладки. */
  warnings: string[];
}

export interface ParseResult {
  metadata: BookMetadata;
  sections: BookSection[];
  /** Сырой объём текста в символах после очистки — для оценки бюджета токенов. */
  rawCharCount: number;
}

export type SupportedExt =
  | "pdf"
  | "epub"
  | "fb2"
  | "docx"
  | "doc"
  | "rtf"
  | "odt"
  | "html"
  | "htm"
  | "txt"
  | "djvu"
  | "djv"
  | "mobi"
  | "azw"
  | "azw3"
  | "pdb"
  | "prc"
  | "chm"
  | "cbz"
  | "cbr"
  | "png"
  | "jpg"
  | "jpeg"
  | "bmp"
  | "tif"
  | "tiff"
  | "webp";

/**
 * Options that any parser may consume. Extending this is non-breaking:
 * parsers ignore unknown fields. Concrete parsers (PDF, image) read their
 * own subset (e.g. ocrEnabled / ocrLanguages).
 */
export interface ParseOptions {
  ocrEnabled?: boolean;
  ocrLanguages?: string[];
  ocrAccuracy?: "fast" | "accurate";
  /** DPI used when rasterising PDF pages for OCR. Higher = better quality but slower. */
  ocrPdfDpi?: number;
  /**
   * DJVU OCR backend selector.
   *   - "auto" (default): system OCR (cheap) → vision-LLM (LM Studio) → none.
   *     Порядок «cheapest first» защищает heavy-очередь от DDoS на длинных
   *     сканах: система пробует OS OCR на каждой странице и поднимает
   *     тяжёлую vision-LLM только если system OCR не справилась.
   *   - "vision-llm": только локальный LM Studio (роль vision_ocr).
   *   - "system": только OS OCR (Windows.Media.Ocr / macOS Vision).
   *   - "none": OCR не выполняется.
   */
  djvuOcrProvider?: "auto" | "system" | "vision-llm" | "none";
  /** Render DPI used by ddjvu page rasterisation. */
  djvuRenderDpi?: number;
  /**
   * Явно выбранный modelKey для vision-OCR (preferences.visionOcrModel).
   * Пробрасывается в `recognizeWithVisionLlm`. Если пусто — vision-OCR
   * сам резолвит модель через `getVisionOcrModel()`.
   */
  visionOcrModel?: string;
  /**
   * Optional override для жёсткого лимита размера DJVU (default 500 MB).
   * Можно поднять для архивных томов (Британника, Большая советская
   * энциклопедия и т.д.) через настройки. Min 50 MB, max 4 GB.
   */
  djvuMaxBytes?: number;
  /**
   * Optional callback для live-progress на per-page OCR. Вызывается ПЕРЕД
   * каждой страницей с {pageIndex, totalPages, source: "text-layer"|"ocr-system"|"ocr-vision"}.
   * Renderer может использовать для прогресс-бара в импорт-pane.
   * No-op если caller не передал — никакого performance penalty.
   */
  onPageProgress?: (event: {
    pageIndex: number;
    totalPages: number;
    source: "text-layer" | "ocr-system" | "ocr-vision";
  }) => void;
  /** Caller-side abort. Honoured by long-running parsers (PDF OCR). */
  signal?: AbortSignal;
}

export interface BookParser {
  ext: SupportedExt;
  parse(filePath: string, opts?: ParseOptions): Promise<ParseResult>;
}

/**
 * Очистить параграф от типографского шума: лишние пробелы, soft-hyphens,
 * не-печатные управляющие символы. Сохраняет переносы строк внутри
 * параграфа (превращает в один пробел) и нормализует ё/й.
 */
export function cleanParagraph(raw: string): string {
  return raw
    .replace(/\u00ad/g, "") // soft hyphen
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Эвристические пороги для `looksLikeHeading`. Подобраны эмпирически по
 *  выборке OCR'd книг (русские/английские scientific PDF). */
export const HEADING_HEURISTIC_CONFIG = {
  /** Pattern 0 hard cutoff: строка длиннее этого никогда не считается заголовком. */
  maxLineChars: 120,
  /** Pattern 2 (numbered): максимум символов для numbered heading. */
  numberedMaxChars: 100,
  /** Pattern 2: с какой позиции искать sentence-ending punct (защита от ложных срабатываний). */
  numberedSentenceCheckOffset: 20,
  /** Pattern 3 (ALL CAPS): максимум символов. */
  allCapsMaxChars: 80,
  /** Pattern 4 (Title Case): максимум символов. */
  titleCaseMaxChars: 100,
  /** Pattern 4: минимум слов в Title Case заголовке. */
  titleCaseMinWords: 2,
  /** Pattern 4: максимум слов в Title Case заголовке. */
  titleCaseMaxWords: 10,
  /** Pattern 4: какая доля слов должна начинаться с заглавной (0..1). */
  titleCaseCapitalizedRatio: 0.6,
} as const;

/** Является ли строка похожей на header / TOC entry (короткая, capitalized). */
export function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > HEADING_HEURISTIC_CONFIG.maxLineChars) return false;

  /* Pattern 1: explicit chapter keywords (RU + EN + DE + FR). */
  if (/^(глава|раздел|часть|введение|заключение|приложение|предисловие|послесловие|содержание|оглавление|chapter|section|part|introduction|conclusion|appendix|preface|foreword|bibliography|references|teil|chapitre|annexe)\b/i.test(trimmed)) return true;

  /* Pattern 2: numbered heading — "1.2 Arrays", "1.2.3. Foo", "§ 3 Bar". */
  if (
    /^(?:§\s*)?\d+(?:\.\d+)*\.?\s+\S/u.test(trimmed)
    && trimmed.length < HEADING_HEURISTIC_CONFIG.numberedMaxChars
    && !/[.!?]\s+\S/.test(trimmed.slice(HEADING_HEURISTIC_CONFIG.numberedSentenceCheckOffset))
  ) return true;

  /* Pattern 3: ALL CAPS line (RU or EN, with digits and punctuation). */
  if (
    /^[А-ЯЁA-Z0-9\s.,:;«»\-—()]+$/.test(trimmed)
    && trimmed.length < HEADING_HEURISTIC_CONFIG.allCapsMaxChars
  ) return true;

  /* Pattern 4: Title Case line that looks like a heading (3-8 words, no
     sentence-ending punctuation at the end except colon). */
  if (trimmed.length < HEADING_HEURISTIC_CONFIG.titleCaseMaxChars && !/[.!?]\s*$/.test(trimmed)) {
    const words = trimmed.split(/\s+/);
    if (
      words.length >= HEADING_HEURISTIC_CONFIG.titleCaseMinWords
      && words.length <= HEADING_HEURISTIC_CONFIG.titleCaseMaxWords
    ) {
      const capitalized = words.filter((w) => /^[\p{Lu}0-9«"(]/u.test(w)).length;
      if (capitalized >= words.length * HEADING_HEURISTIC_CONFIG.titleCaseCapitalizedRatio) return true;
    }
  }

  return false;
}
