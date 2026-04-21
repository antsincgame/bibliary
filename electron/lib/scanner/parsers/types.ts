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
  | "txt"
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

/** Является ли строка похожей на header / TOC entry (короткая, capitalized). */
export function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (/^(глава|раздел|часть|chapter|section|part)\b/i.test(trimmed)) return true;
  if (/^[А-ЯЁA-Z0-9\s.,:;«»\-—()]+$/.test(trimmed) && trimmed.length < 80) return true;
  return false;
}
