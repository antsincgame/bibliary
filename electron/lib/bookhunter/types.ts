/**
 * Phase 3.0 — BookHunter контракты.
 *
 * Все источники — только legal public API. License whitelist строгий.
 */

export type LicenseTag =
  | "public-domain"
  | "cc-by"
  | "cc-by-sa"
  | "cc0"
  | "open-access"
  | "unknown";

export interface BookCandidate {
  /** Уникальный id внутри источника (gutenberg.org id, archive.org identifier, ...). */
  id: string;
  sourceTag: "gutendex" | "archive" | "openlibrary" | "arxiv";
  title: string;
  authors: string[];
  /** ISO 639-1 код языка, если известен. */
  language?: string;
  year?: number;
  /** Вид файла: txt, epub, pdf. */
  formats: BookFileVariant[];
  /** Поисковый score (relevance) — для ranking. */
  searchScore?: number;
  license: LicenseTag;
  /** URL веб-страницы (Open Library / arxiv abs / gutenberg ebook page). */
  webPageUrl?: string;
  description?: string;
}

export interface BookFileVariant {
  format: "txt" | "epub" | "pdf" | "fb2" | "docx";
  url: string;
  /** Размер в байтах, если HEAD дал; иначе undefined. */
  sizeBytes?: number;
}

export interface SearchOptions {
  query: string;
  language?: string;
  /** Ограничение на источник по итогам. */
  perSourceLimit?: number;
  /** Только эти источники (default — все). */
  sources?: BookCandidate["sourceTag"][];
  /** AbortSignal для отмены. */
  signal?: AbortSignal;
}

export interface BookSource {
  tag: BookCandidate["sourceTag"];
  search(opts: SearchOptions): Promise<BookCandidate[]>;
}

export const ALLOWED_LICENSES: ReadonlySet<LicenseTag> = new Set<LicenseTag>([
  "public-domain",
  "cc-by",
  "cc-by-sa",
  "cc0",
  "open-access",
]);

export const USER_AGENT = "Bibliary/2.4 (+https://github.com/bibliary/bibliary)";
