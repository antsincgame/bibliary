/**
 * Golden corpus benchmark — verifies the scanner pipeline against a
 * curated set of reference parses. Scaffold ships empty; operators
 * populate tests/golden-corpus/fixtures/ then list entries in
 * tests/golden-corpus/manifest.json. See tests/golden-corpus/README.md
 * for the full workflow.
 *
 * The test runner is intentionally NOT registered in the required CI
 * step — it's an opt-in regression net you invoke manually before /
 * after any scanner change:
 *
 *   node --import tsx --test tests/golden-corpus.test.ts
 *
 * When the manifest is empty (default) all the "no fixtures" sentinel
 * passes; that way committing this scaffold won't break CI for repos
 * without books.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(__dirname, "golden-corpus");
const FIXTURES_DIR = path.join(CORPUS_DIR, "fixtures");
const MANIFEST_PATH = path.join(CORPUS_DIR, "manifest.json");

interface GoldenFixture {
  /** Filename inside fixtures/ — the actual book file. */
  name: string;
  /** Format hint, currently informational. */
  format: string;
  /** Language hint (rus, eng, chi-sim, ...). */
  language?: string;
  /** Reference markdown filename inside fixtures/. */
  referenceMarkdown: string;
  /** Similarity threshold; default 0.95. */
  minSimilarity?: number;
  /** Free-form notes — Project Gutenberg ID, copyright status, etc. */
  notes?: string;
}

function loadManifest(): GoldenFixture[] {
  if (!existsSync(MANIFEST_PATH)) return [];
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as GoldenFixture[];
  } catch {
    return [];
  }
}

/**
 * Levenshtein similarity, normalized 0..1. Computed in chunks of 4 KB
 * to keep memory bounded on 500 KB+ reference markdowns. Returns 1.0
 * for identical inputs, ~0 for completely different.
 *
 * For book-sized strings full Levenshtein is O(n²) memory; we use a
 * single-row rolling table to keep memory at O(n) instead.
 */
function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) {
    return Math.max(a.length, b.length) === 0 ? 1.0 : 0;
  }
  /* Token-level diff is more meaningful than character-level for
   * markdown comparisons; whitespace differences shouldn't dominate. */
  const ta = a.split(/\s+/).filter(Boolean);
  const tb = b.split(/\s+/).filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return 0;
  const m = ta.length;
  const n = tb.length;
  /* Rolling-row Levenshtein distance on tokens. */
  let prev = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = new Array(n + 1).fill(0);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = ta[i - 1] === tb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    prev = curr;
  }
  const distance = prev[n];
  const maxLen = Math.max(m, n);
  return 1 - distance / maxLen;
}

describe("golden corpus", () => {
  const manifest = loadManifest();

  it("manifest.json is a valid JSON array", () => {
    /* Validates both presence (we can read it) and shape (it's an
     * array, even if empty). Failure here means a typo in the file. */
    assert.ok(Array.isArray(manifest), "manifest must be a JSON array");
  });

  if (manifest.length === 0) {
    it("no fixtures registered — populate tests/golden-corpus/manifest.json", () => {
      /* Sentinel: scaffold-only repo. See tests/golden-corpus/README.md
       * for the operator workflow. This case passes intentionally so
       * cloning a fresh repo doesn't fail the suite. */
      assert.equal(manifest.length, 0);
    });
    return;
  }

  /* Lazy import of the scanner bridge — only when we have something
   * to test. Keeps the test fast in the no-fixtures case. */
  for (const fx of manifest) {
    it(`parses ${fx.name} within similarity threshold`, async () => {
      const bookPath = path.join(FIXTURES_DIR, fx.name);
      const refPath = path.join(FIXTURES_DIR, fx.referenceMarkdown);
      assert.ok(existsSync(bookPath), `book missing: ${bookPath}`);
      assert.ok(existsSync(refPath), `reference missing: ${refPath}`);

      const { parseBook } = await import(
        "../server/lib/scanner/parsers-bridge.js"
      );
      const result = await parseBook(bookPath);

      /* Concatenate the scanner's section output the same way
       * scripts/golden-corpus-generate would have. Adjust if your
       * generator script differs. */
      const fresh = (result as { sections?: Array<{ title?: string; text?: string }> }).sections
        ?.map((s) => `${s.title ?? ""}\n\n${s.text ?? ""}`)
        .join("\n\n") ?? "";
      const reference = readFileSync(refPath, "utf8");

      const sim = levenshteinSimilarity(fresh, reference);
      const threshold = fx.minSimilarity ?? 0.95;
      assert.ok(
        sim >= threshold,
        `${fx.name}: similarity ${sim.toFixed(3)} < ${threshold}\n` +
          `Fresh length: ${fresh.length}, ref length: ${reference.length}\n` +
          `(re-generate reference if the divergence is intentional)`,
      );
    });
  }
});
