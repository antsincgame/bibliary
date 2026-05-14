/**
 * Phase 8b — pure smoke for the export-queue helpers. No Appwrite, no
 * HTTP — only the deterministic predicates that decide which queue a
 * given job belongs to and which format a build doc was created with.
 *
 * The full worker loop (enqueue → drain → runDatasetBuild → upload)
 * needs a docker-compose Appwrite to run end-to-end and is out of
 * scope for this tier of test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isExportJobStage } from "../server/lib/queue/job-store.ts";
import { parseFormatFromStage } from "../server/lib/queue/export-queue.ts";

describe("export-queue: isExportJobStage", () => {
  it("recognises build:<format> as export", () => {
    assert.equal(isExportJobStage("build:jsonl"), true);
    assert.equal(isExportJobStage("build:sharegpt"), true);
    assert.equal(isExportJobStage("build:chatml"), true);
  });

  it("treats extraction-queue stages as NOT-export", () => {
    /* Extraction queue uses these stage values — they must never be
     * picked up by the export queue. */
    assert.equal(isExportJobStage("queued"), false);
    assert.equal(isExportJobStage("running"), false);
    assert.equal(isExportJobStage("done"), false);
    assert.equal(isExportJobStage("failed"), false);
    assert.equal(isExportJobStage("cancelled"), false);
    assert.equal(isExportJobStage("orphan-reset"), false);
  });

  it("handles null / undefined / empty gracefully", () => {
    assert.equal(isExportJobStage(null), false);
    assert.equal(isExportJobStage(undefined), false);
    assert.equal(isExportJobStage(""), false);
  });

  it("rejects unrelated build-prefixed strings outside the convention", () => {
    /* The predicate is intentionally generous (startsWith) so future
     * formats slot in without code change. That generosity matters
     * for the routing decision; specific format gets re-validated in
     * parseFormatFromStage. */
    assert.equal(isExportJobStage("buildup"), false);
    assert.equal(isExportJobStage("rebuild"), false);
    /* But true prefix matches: even unknown format flows through the
     * export queue (where it then fails fast in parseFormatFromStage). */
    assert.equal(isExportJobStage("build:future-format"), true);
  });
});

describe("export-queue: parseFormatFromStage", () => {
  it("decodes the three supported formats", () => {
    assert.equal(parseFormatFromStage("build:jsonl"), "jsonl");
    assert.equal(parseFormatFromStage("build:sharegpt"), "sharegpt");
    assert.equal(parseFormatFromStage("build:chatml"), "chatml");
  });

  it("returns null for non-export stages", () => {
    assert.equal(parseFormatFromStage("queued"), null);
    assert.equal(parseFormatFromStage("running"), null);
    assert.equal(parseFormatFromStage("done"), null);
    assert.equal(parseFormatFromStage(null), null);
  });

  it("returns null for build-prefixed but unknown format", () => {
    /* This is the fail-fast path: someone wrote `build:openai-ft`
     * before the worker learned that format. Must NOT silently fall
     * back to jsonl. */
    assert.equal(parseFormatFromStage("build:openai-ft"), null);
    assert.equal(parseFormatFromStage("build:"), null);
    assert.equal(parseFormatFromStage("build:JSONL"), null); /* case-sensitive */
  });
});
