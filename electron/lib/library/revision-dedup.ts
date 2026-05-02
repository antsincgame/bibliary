import { listBooksForRevisionDedup, type RevisionDedupBook, getBookById, deleteBook } from "./cache-db.js";
import { unregisterFromNearDup } from "./near-dup-detector.js";
import { resolveCatalogSidecarPaths } from "./storage-contract.js";
import { getPriority } from "./format-priority.js";
import type { BookCatalogMeta, SupportedBookFormat } from "./types.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as telemetry from "../resilience/telemetry.js";

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
  const sourceName = sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : undefined;
  const parts = [metaLike.title, metaLike.titleEn, metaLike.sourceArchive, sourceName];
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
  if (title.length < 4) return null;
  if (author.length < 2) {
    return title.length >= 10 ? `${title}|` : null;
  }
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

/**
 * Iter 12 P6.2: используем единый format-priority.ts (Phalanx unification).
 * Старая локальная мапа была на 6 форматов, новая — на 22 (epub/pdf/djvu/fb2/
 * docx/azw3/mobi/rtf/odt/lit/lrf/snb/pdb/prc/chm/cbz/cbr/tcr/txt/html).
 */
export function getFormatPriority(format: string): number {
  return getPriority(format);
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

/**
 * Iter 12 P1.2: HARD+REPLACE strategy — удалить старую (более слабую)
 * ревизию ПОСЛЕ успешного импорта новой.
 *
 * Phalanx Risk Mitigation #2 (Google review):
 *   - Оригиналы пользователя НЕ трогаем — только library/<bookId>/.
 *   - Удаление ТОЛЬКО после успеха нового кандидата (caller отвечает).
 *   - Sidecars (md, original, meta.json, illustrations.json) удаляем
 *     индивидуально (не rmdir bookDir, т.к. там может быть ещё одна книга
 *     в legacy-layout: data/library/<lang>/<domain>/<author>/).
 *   - Telemetry event `revision.replaced` пишет old/new id+title для аудита.
 *   - Best-effort: если remove файла упал — логгируем warning, не throw
 *     (новая книга уже добавлена; пусть лучше старые orphan-файлы остануся,
 *     чем пользователь потеряет обе книги).
 *   - Qdrant orphan-vectors не убиваем здесь — это делают периодические
 *     scanner-ы (см. library:delete-book IPC).
 */
export async function replaceBookRevision(
  oldBookId: string,
  newMeta: BookCatalogMeta,
): Promise<{ ok: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const oldMeta = getBookById(oldBookId);
  if (!oldMeta) {
    warnings.push(`replaceBookRevision: old book ${oldBookId} not in DB anymore (skipped)`);
    return { ok: false, warnings };
  }

  /* DB row delete first — атомарная транзакция в better-sqlite3. Если
     дальше упадёт, в DB новая книга уже есть (caller вызвал upsertBook),
     старая пропала. Это лучше чем оставить две конкурирующие записи. */
  try {
    deleteBook(oldBookId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`replaceBookRevision: deleteBook(${oldBookId}) failed: ${msg}`);
    return { ok: false, warnings };
  }

  /* Files cleanup — best-effort. Если что-то упадёт, оставим orphan-файлы. */
  try {
    const sidecars = await resolveCatalogSidecarPaths(oldMeta);
    const targets = [
      oldMeta.mdPath,
      sidecars.originalPath,
      sidecars.metaPath,
      sidecars.illustrationsPath,
    ];
    for (const p of targets) {
      try { await fs.rm(p, { force: true }); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`replaceBookRevision: rm ${path.basename(p)} failed: ${msg}`);
      }
    }
    /* Best-effort: попытка удалить пустую bookDir. ENOTEMPTY игнорируем. */
    await fs.rmdir(sidecars.bookDir).catch(() => undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`replaceBookRevision: sidecars cleanup failed: ${msg}`);
  }

  /* In-memory caches: near-dup tracker и revision-dedup index. */
  try {
    unregisterFromNearDup(oldMeta);
    resetRevisionDedupCache();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`replaceBookRevision: cache cleanup failed: ${msg}`);
  }

  telemetry.logEvent({
    type: "revision.replaced",
    oldBookId,
    newBookId: newMeta.id,
    oldTitle: oldMeta.title,
    newTitle: newMeta.title,
    oldFormat: oldMeta.originalFormat,
    newFormat: newMeta.originalFormat,
    oldYear: oldMeta.year,
    newYear: newMeta.year,
  });

  return { ok: true, warnings };
}

