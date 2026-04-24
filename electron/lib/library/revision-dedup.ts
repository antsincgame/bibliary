import { listBooksForRevisionDedup, type RevisionDedupBook } from "./cache-db.js";
import type { BookCatalogMeta, SupportedBookFormat } from "./types.js";

export interface RevisionDedupMatch {
  bookId: string;
  score: number;
  title: string;
}

interface IndexedBook extends RevisionDedupBook {
  workKey: string | null;
  revisionScore: number;
}

let cache: Map<string, IndexedBook[]> | null = null;
let isbnIndex: Map<string, { bookId: string; title: string; format?: SupportedBookFormat }> | null = null;

function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripRevisionMarkers(s: string): string {
  return s
    .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
    .replace(/\b\d{1,3}(st|nd|rd|th)\s*ed(ition)?\b/gi, " ")
    .replace(/\b(?:edition|ed\.?|версия|version|v)\s*\d{1,3}\b/gi, " ")
    .replace(/\b(?:revised|updated|update|переработан|исправлен|дополнен|редакция|издание)\b/gi, " ");
}

function extractYearSignals(text: string): number {
  const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length === 0) return 0;
  const latest = Math.max(...years);
  return Math.max(0, latest - 1900);
}

function extractEditionSignals(text: string): number {
  let score = 0;
  const compact = text.toLowerCase();
  const patterns: RegExp[] = [
    /\b(\d{1,2})(st|nd|rd|th)\s*ed(ition)?\b/gi,
    /\b(?:edition|ed\.?|издани[ея]|редакци[яи])\s*(\d{1,2})\b/gi,
    /\b(\d{1,2})\s*(?:edition|ed\.?|издани[ея]|редакци[яи])\b/gi,
    /\bv(?:er(?:sion)?)?[\s._-]*(\d{1,3})\b/gi,
  ];
  for (const re of patterns) {
    for (const m of compact.matchAll(re)) {
      const n = Number((m[1] || m[0] || "").replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n > 0) score += Math.min(40, n * 4);
    }
  }
  if (/\b(revised|updated|update|переработан|исправлен|дополнен|новая редакция)\b/i.test(compact)) {
    score += 20;
  }
  return score;
}

function buildSemanticCorpus(metaLike: {
  title?: string;
  titleEn?: string;
  sourceArchive?: string;
}, sourcePath?: string): string {
  void sourcePath;
  const parts = [metaLike.title, metaLike.titleEn, metaLike.sourceArchive];
  return parts.filter(Boolean).join(" ");
}

export function buildWorkKey(metaLike: {
  title?: string;
  titleEn?: string;
  author?: string;
  authorEn?: string;
}): string | null {
  const titleRaw = metaLike.titleEn || metaLike.title || "";
  const authorRaw = metaLike.authorEn || metaLike.author || "";
  const title = normalizeText(stripRevisionMarkers(titleRaw));
  const author = normalizeText(authorRaw);
  if (title.length < 4 || author.length < 2) return null;
  return `${title}|${author}`;
}

export function computeRevisionScore(metaLike: {
  title?: string;
  titleEn?: string;
  sourceArchive?: string;
}, sourcePath?: string): number {
  const corpus = buildSemanticCorpus(metaLike, sourcePath);
  return extractYearSignals(corpus) + extractEditionSignals(corpus);
}

function ensureCache(): Map<string, IndexedBook[]> {
  if (cache) return cache;
  cache = new Map();
  for (const b of listBooksForRevisionDedup()) {
    const workKey = buildWorkKey(b);
    if (!workKey) continue;
    const indexed: IndexedBook = {
      ...b,
      workKey,
      revisionScore: computeRevisionScore(b),
    };
    const arr = cache.get(workKey) ?? [];
    arr.push(indexed);
    cache.set(workKey, arr);
  }
  return cache;
}

export function registerForRevisionDedup(meta: BookCatalogMeta): void {
  registerIsbn(meta);
  const workKey = buildWorkKey(meta);
  if (!workKey) return;
  const store = ensureCache();
  const arr = store.get(workKey) ?? [];
  arr.push({
    id: meta.id,
    title: meta.title,
    author: meta.author,
    titleEn: meta.titleEn,
    authorEn: meta.authorEn,
    sourceArchive: meta.sourceArchive,
    year: meta.year,
    isbn: meta.isbn,
    workKey,
    revisionScore: computeRevisionScore(meta),
  });
  store.set(workKey, arr);
}

export function resetRevisionDedupCache(): void {
  cache = null;
  isbnIndex = null;
}

// ── ISBN dedup (Tier 1) ─────────────────────────────────────────────────────

function isbn10to13(isbn10: string): string {
  const body = "978" + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return body + check;
}

export function normalizeIsbn(raw: string): string | null {
  const digits = raw.replace(/[-\s]/g, "");
  if (digits.length === 13 && /^(978|979)/.test(digits)) return digits;
  if (digits.length === 10 && /^\d{9}[\dXx]$/.test(digits)) return isbn10to13(digits);
  return null;
}

function ensureIsbnIndex(): Map<string, { bookId: string; title: string; format?: SupportedBookFormat }> {
  if (isbnIndex) return isbnIndex;
  isbnIndex = new Map();
  for (const b of listBooksForRevisionDedup()) {
    if (!b.isbn) continue;
    const norm = normalizeIsbn(b.isbn);
    if (norm) isbnIndex.set(norm, { bookId: b.id, title: b.title });
  }
  return isbnIndex;
}

export function registerIsbn(meta: BookCatalogMeta): void {
  if (!meta.isbn) return;
  const norm = normalizeIsbn(meta.isbn);
  if (!norm) return;
  const idx = ensureIsbnIndex();
  const existing = idx.get(norm);
  if (existing && existing.bookId !== meta.id) {
    console.warn(`[revision-dedup] ISBN ${norm} collision: ${existing.bookId} vs ${meta.id} — keeping first`);
    return;
  }
  idx.set(norm, { bookId: meta.id, title: meta.title, format: meta.originalFormat });
}

export function findIsbnMatch(isbn: string | undefined): { bookId: string; title: string; format?: SupportedBookFormat } | null {
  if (!isbn) return null;
  const norm = normalizeIsbn(isbn);
  if (!norm) return null;
  return ensureIsbnIndex().get(norm) ?? null;
}

// ── Format preference ───────────────────────────────────────────────────────

const FORMAT_PRIORITY: Record<string, number> = {
  epub: 5,
  pdf: 4,
  djvu: 3,
  fb2: 2,
  docx: 1,
  txt: 0,
};

export function getFormatPriority(format: string): number {
  return FORMAT_PRIORITY[format] ?? -1;
}

export function findLatestRevisionMatch(
  candidate: BookCatalogMeta,
  sourcePath?: string
): RevisionDedupMatch | null {
  void sourcePath;
  const workKey = buildWorkKey(candidate);
  if (!workKey) return null;
  const store = ensureCache();
  const existing = store.get(workKey);
  if (!existing || existing.length === 0) return null;
  const sorted = existing
    .slice()
    .sort((a, b) => b.revisionScore - a.revisionScore || a.id.localeCompare(b.id));
  const best = sorted[0];
  return { bookId: best.id, score: best.revisionScore, title: best.title };
}

