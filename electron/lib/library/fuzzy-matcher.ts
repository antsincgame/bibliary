/**
 * Fuzzy book matching -- aggressive Unicode normalization + Levenshtein.
 *
 * No Soundex (doesn't work for Cyrillic and mixed-script metadata).
 * Uses `fastest-levenshtein` for O(nm) distance with ~10x perf over naive.
 *
 * Blocking strategy: TitlePrefix(6) + FirstAuthorSurname to avoid O(n^2).
 */

import { distance } from "fastest-levenshtein";

// ── Normalization ──────────────────────────────────────────────────────────

const ARTICLES = /\b(the|a|an|и|в|на|по|для|из|от)\b/gi;
const EDITION_STRIP = /\b\d{1,2}(st|nd|rd|th)\s*(edition|ed\.?)\b/gi;
const EDITION_WORD = /\b(edition|ed\.?|revised|updated|expanded|annotated|издани[ея]|редакци[яи]|переработан)\b/gi;

export function aggressiveNormalize(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(ARTICLES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripEditionMarkers(s: string): string {
  return s
    .replace(EDITION_STRIP, " ")
    .replace(EDITION_WORD, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSurnameAndInitial(author: string): string {
  const norm = aggressiveNormalize(author);
  const parts = norm.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  const firstInitial = parts[0][0] ?? "";
  return `${last} ${firstInitial}`;
}

// ── Similarity ─────────────────────────────────────────────────────────────

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - distance(a, b) / maxLen;
}

function yearProximityScore(y1: number | undefined, y2: number | undefined): number {
  if (y1 === undefined || y2 === undefined) return 0.5;
  const diff = Math.abs(y1 - y2);
  if (diff === 0) return 1.0;
  if (diff <= 3) return 0.8;
  if (diff <= 5) return 0.3;
  return 0.0;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface BookFingerprint {
  id: string;
  title: string;
  author: string;
  year?: number;
  isbn?: string;
  path?: string;
  format?: string;
}

export interface FuzzyMatchResult {
  confidence: number;
  bookA: BookFingerprint;
  bookB: BookFingerprint;
}

const WEIGHT_TITLE = 0.50;
const WEIGHT_AUTHOR = 0.30;
const WEIGHT_YEAR = 0.15;
const WEIGHT_ISBN_BONUS = 0.05;

export function computeFuzzyConfidence(a: BookFingerprint, b: BookFingerprint): number {
  const titleA = aggressiveNormalize(stripEditionMarkers(a.title));
  const titleB = aggressiveNormalize(stripEditionMarkers(b.title));
  if (!titleA || !titleB) return 0;
  const titleSim = levenshteinRatio(titleA, titleB);

  const authorA = extractSurnameAndInitial(a.author);
  const authorB = extractSurnameAndInitial(b.author);
  const authorSim = authorA && authorB ? levenshteinRatio(authorA, authorB) : (!authorA && !authorB ? 0.3 : 0.0);

  const yearSim = yearProximityScore(a.year, b.year);

  let isbnBonus = 0;
  if (a.isbn && b.isbn && a.isbn === b.isbn) isbnBonus = 1.0;

  return (
    WEIGHT_TITLE * titleSim +
    WEIGHT_AUTHOR * authorSim +
    WEIGHT_YEAR * yearSim +
    WEIGHT_ISBN_BONUS * isbnBonus
  );
}

/**
 * Blocking key for O(n log n) grouping instead of O(n^2) pairwise.
 * Concatenates first 6 chars of normalized title + author surname.
 */
export function buildBlockingKey(fp: BookFingerprint): string {
  const title = aggressiveNormalize(stripEditionMarkers(fp.title));
  const prefix = title.slice(0, 6);
  const parts = aggressiveNormalize(fp.author).split(/\s+/).filter(Boolean);
  const surname = parts[parts.length - 1] ?? "";
  return `${prefix}|${surname}`;
}

/**
 * Find all fuzzy duplicate pairs within a list of book fingerprints.
 * Uses blocking to avoid full O(n^2). Returns pairs sorted by confidence desc.
 */
export function findFuzzyDuplicates(
  books: BookFingerprint[],
  threshold = 0.70,
): FuzzyMatchResult[] {
  const blocks = new Map<string, BookFingerprint[]>();
  for (const b of books) {
    const key = buildBlockingKey(b);
    const arr = blocks.get(key) ?? [];
    arr.push(b);
    blocks.set(key, arr);
  }

  const results: FuzzyMatchResult[] = [];
  const seen = new Set<string>();

  for (const group of blocks.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const confidence = computeFuzzyConfidence(a, b);
        if (confidence >= threshold) {
          results.push({ confidence, bookA: a, bookB: b });
        }
      }
    }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}
