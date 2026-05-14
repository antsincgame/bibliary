/**
 * Golden-corpus regression runner.
 *
 * Walks `tests/golden-corpus/fixtures/manifest.json`, re-parses every
 * fixture with the current scanner, and asserts the render stays within
 * each entry's `minSimilarity` of its committed `.ref.md` reference.
 *
 * It ships **inert**: the corpus is empty by design (copyright + clone
 * size), so with no manifest entries this is a single trivial pass.
 * Once the operator populates `tests/golden-corpus/fixtures/` and runs
 * `npm run golden:generate`, it becomes the real zero-regression gate —
 * run it standalone before/after a scanner change with:
 *
 *   npm run golden:check
 *
 * Render + similarity live in `tests/golden-corpus/harness.ts`, shared
 * with the generator so the reference and the live parse are rendered
 * by the exact same code path.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  firstDivergence,
  fixtureExists,
  loadManifest,
  parseFixture,
  readReference,
  similarity,
} from "./golden-corpus/harness.ts";

const manifest = loadManifest();

describe("golden corpus", () => {
  if (manifest.length === 0) {
    it("corpus is empty — populate tests/golden-corpus/fixtures/ to enable the gate", () => {
      /* By design: books are operator-supplied and not committed.
       * See tests/golden-corpus/README.md. */
      assert.ok(true);
    });
    return;
  }

  for (const entry of manifest) {
    /* Books are operator-supplied and not committed — a committed
     * manifest entry with no local file (fresh clone / CI) skips
     * cleanly rather than failing on a missing fixture. */
    const opts = fixtureExists(entry.name)
      ? {}
      : { skip: "fixture book not present (operator-supplied, not committed)" };
    it(
      `${entry.name} — parse stays >= ${entry.minSimilarity} similar to its reference`,
      opts,
      async () => {
        const live = await parseFixture(entry.name);
        const ref = readReference(entry.referenceMarkdown);
        const { score, unit } = similarity(ref, live);
        assert.ok(
          score >= entry.minSimilarity,
          `${entry.name}: ${unit}-similarity ${score.toFixed(4)} < ` +
            `${entry.minSimilarity}\n${firstDivergence(ref, live)}`,
        );
      },
    );
  }
});
