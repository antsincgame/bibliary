/**
 * Golden-corpus harness — shared between the reference generator
 * (`scripts/golden-corpus-generate.ts`) and the regression runner
 * (`tests/golden-corpus.test.ts`).
 *
 * The golden corpus is the zero-regression gate for scanner changes
 * (the Phase 0b Electron-retirement migration, future mupdf / MinerU
 * swaps, …): capture the *current* parse of a curated book set, then
 * after a change assert the new parse stays within a similarity
 * threshold of that captured reference.
 *
 * See `tests/golden-corpus/README.md` for the workflow. The corpus
 * ships empty by design (copyright + clone size) — books are
 * operator-supplied under `tests/golden-corpus/fixtures/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseBook } from "../../server/lib/scanner/parsers-bridge.ts";
import type { ParseResult } from "../../server/lib/scanner/parser-types.ts";

/** `tests/golden-corpus/fixtures` — operator-supplied books, their
 *  verified `.ref.md` references, and `manifest.json` all live here. */
export const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

export interface GoldenEntry {
  /** Fixture book filename, relative to {@link FIXTURES_DIR}. */
  name: string;
  /** Source format (pdf / epub / djvu / …) — informational. */
  format: string;
  /** Book language (rus / eng / chi-sim / …) — informational. */
  language?: string;
  /** Verified reference markdown filename, relative to {@link FIXTURES_DIR}. */
  referenceMarkdown: string;
  /** Pass threshold for the similarity score (0..1). Typically 0.95. */
  minSimilarity: number;
  /** Provenance / caveats — e.g. the source URL. */
  notes?: string;
}

/**
 * Canonical text rendering of a parse result. Both the generator and
 * the runner go through this so the comparison is apples-to-apples, and
 * it is also what the operator hand-verifies. Section levels become `#`
 * heading depth so a structural regression (a chapter's level changing)
 * shows up as a diff, not just prose drift.
 */
export function renderParse(result: ParseResult): string {
  const m = result.metadata;
  const lines: string[] = [`# ${m.title}`];
  if (m.author) lines.push(`author: ${m.author}`);
  if (m.language) lines.push(`language: ${m.language}`);
  if (m.year !== undefined) lines.push(`year: ${m.year}`);
  if (m.publisher) lines.push(`publisher: ${m.publisher}`);
  if (m.identifier) lines.push(`identifier: ${m.identifier}`);
  lines.push(`rawCharCount: ${result.rawCharCount}`);
  if (m.warnings.length > 0) lines.push(`warnings: ${m.warnings.join(" | ")}`);
  lines.push("");
  for (const s of result.sections) {
    lines.push(`${"#".repeat(s.level)} ${s.title}`);
    lines.push("");
    if (s.paragraphs.length > 0) lines.push(s.paragraphs.join("\n\n"), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Parse a fixture with the *default* (no-OCR, no-LLM) options and render
 * it. OCR-dependent fixtures would need deterministic OCR config — out
 * of scope until the corpus actually includes one.
 */
export async function parseFixture(name: string): Promise<string> {
  const result = await parseBook(join(FIXTURES_DIR, name));
  return renderParse(result);
}

/** Read a committed reference markdown by filename (relative to {@link FIXTURES_DIR}). */
export function readReference(referenceMarkdown: string): string {
  return readFileSync(join(FIXTURES_DIR, referenceMarkdown), "utf-8");
}

/**
 * Parse the fixtures manifest. A missing or empty file yields `[]` (the
 * corpus simply is not populated yet); a malformed file throws loud.
 */
export function loadManifest(): GoldenEntry[] {
  let raw: string;
  try {
    raw = readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf-8");
  } catch {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("[golden] manifest.json must be a JSON array of entries");
  }
  return parsed as GoldenEntry[];
}

/**
 * Two-row Levenshtein edit distance over two token arrays — O(n·m)
 * time, O(min(n,m)) space.
 */
function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  /* Keep the shorter array as the inner row to bound the space. */
  let short = a;
  let long = b;
  if (a.length > b.length) {
    short = b;
    long = a;
  }
  let prev = Array.from({ length: short.length + 1 }, (_, i) => i);
  let curr = new Array<number>(short.length + 1);
  for (let i = 1; i <= long.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= short.length; j++) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[short.length];
}

const LARGE_TOKEN_LIMIT = 40_000;

/**
 * Normalized 0..1 similarity between a reference render and a live one.
 * Token-level (whitespace-split) Levenshtein; for very large texts it
 * falls back to line-level so the O(n·m) DP stays tractable.
 */
export function similarity(
  refText: string,
  liveText: string,
): { score: number; unit: "token" | "line" } {
  if (refText === liveText) return { score: 1, unit: "token" };
  let unit: "token" | "line" = "token";
  let a = refText.split(/\s+/).filter(Boolean);
  let b = liveText.split(/\s+/).filter(Boolean);
  if (Math.max(a.length, b.length) > LARGE_TOKEN_LIMIT) {
    unit = "line";
    a = refText.split("\n");
    b = liveText.split("\n");
  }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return { score: 1, unit };
  return { score: 1 - levenshtein(a, b) / maxLen, unit };
}

/**
 * A short context preview of where two renders first diverge — fed into
 * the assertion message so a failing run points straight at the
 * regression instead of just reporting a number.
 */
export function firstDivergence(refText: string, liveText: string): string {
  const ref = refText.split("\n");
  const live = liveText.split("\n");
  const n = Math.min(ref.length, live.length);
  let i = 0;
  while (i < n && ref[i] === live[i]) i++;
  const from = Math.max(0, i - 2);
  const slice = (arr: string[]): string =>
    arr
      .slice(from, i + 3)
      .map((l, k) => `  ${from + k === i ? ">" : " "} | ${l}`)
      .join("\n");
  return (
    `  first divergence at line ${i + 1}:\n` +
    `  --- reference ---\n${slice(ref)}\n` +
    `  --- live ---\n${slice(live)}`
  );
}
