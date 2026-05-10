/**
 * tests/audit-batch-dispatcher.test.ts
 *
 * Pure-unit покрытие applyBatchEvent (renderer/library/batch-actions.js) —
 * единственного пути, по которому progress-event'ы из main process попадают
 * в renderer state (BATCH counters + CATALOG.rows status).
 *
 * До этого теста dispatcher не имел покрытия. Любая регрессия (например,
 * забыли case 'filtered' или off-by-one на done counter) проходила в
 * production: progress UI лжёт, статусы строк не обновляются.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBatchEvent } from "../renderer/library/batch-actions.js";
import { BATCH, CATALOG } from "../renderer/library/state.js";

/* ─── helpers ──────────────────────────────────────────────────────── */

/** Singleton state в renderer — ресетим перед каждым тестом. */
function resetState(): void {
  BATCH.active = false;
  BATCH.batchId = null;
  BATCH.total = 0;
  BATCH.done = 0;
  BATCH.skipped = 0;
  BATCH.failed = 0;
  BATCH.currentBookId = null;
  BATCH.currentBookTitle = null;
  BATCH.lastJobId = null;
  BATCH.collection = null;
  CATALOG.rows = [];
  CATALOG.selected.clear();
}

/* updateBatchUi внутри dispatcher делает root.querySelector — null safe.
 * dummy root возвращает null на любой селектор → ветки UI пропускаются
 * без падения. */
const dummyRoot = { querySelector: (): null => null } as unknown as HTMLElement;
const dummyDeps = { renderCatalogTable: (): void => undefined };

/* ─── jobId / batchId stickiness ───────────────────────────────────── */

test("[batch-dispatcher] jobId / batchId stick on every event regardless of stage", () => {
  resetState();
  applyBatchEvent(dummyRoot, { jobId: "job-x", batchId: "batch-y", stage: "noop" }, dummyDeps);
  assert.equal(BATCH.lastJobId, "job-x");
  assert.equal(BATCH.batchId, "batch-y");
});

test("[batch-dispatcher] non-string jobId / batchId ignored (no type coercion)", () => {
  resetState();
  applyBatchEvent(dummyRoot, { jobId: 42, batchId: null, stage: "noop" }, dummyDeps);
  assert.equal(BATCH.lastJobId, null);
  assert.equal(BATCH.batchId, null);
});

/* ─── stage='batch' phase='start' ──────────────────────────────────── */

test("[batch-dispatcher] phase='start' sets total", () => {
  resetState();
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "start", total: 12 }, dummyDeps);
  assert.equal(BATCH.total, 12);
});

test("[batch-dispatcher] phase='start' without total preserves existing", () => {
  resetState();
  BATCH.total = 7;
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "start" }, dummyDeps);
  assert.equal(BATCH.total, 7);
});

/* ─── stage='batch' phase='filtered' ───────────────────────────────── */

test("[batch-dispatcher] phase='filtered' sets total to eligible and adds to skipped", () => {
  resetState();
  BATCH.total = 100;
  BATCH.skipped = 0;
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "filtered", eligible: 80, skipped: 20 }, dummyDeps);
  assert.equal(BATCH.total, 80);
  assert.equal(BATCH.skipped, 20);
});

test("[batch-dispatcher] phase='filtered' twice accumulates skipped", () => {
  resetState();
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "filtered", eligible: 80, skipped: 20 }, dummyDeps);
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "filtered", eligible: 70, skipped: 5 }, dummyDeps);
  assert.equal(BATCH.total, 70, "total replaced by latest eligible");
  assert.equal(BATCH.skipped, 25, "skipped accumulates across filtered events");
});

test("[batch-dispatcher] phase='filtered' without skipped uses 0", () => {
  resetState();
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "filtered", eligible: 50 }, dummyDeps);
  assert.equal(BATCH.total, 50);
  assert.equal(BATCH.skipped, 0);
});

/* ─── stage='batch' phase='book-start' ─────────────────────────────── */

test("[batch-dispatcher] phase='book-start' updates current + flips matched row to crystallizing", () => {
  resetState();
  CATALOG.rows = [
    { id: "a", title: "A", status: "evaluated", lastError: "stale", wordCount: 1 },
    { id: "b", title: "B", status: "evaluated", wordCount: 1 },
  ];
  applyBatchEvent(dummyRoot, {
    stage: "batch", phase: "book-start", bookId: "a", bookTitle: "A title",
  }, dummyDeps);
  assert.equal(BATCH.currentBookId, "a");
  assert.equal(BATCH.currentBookTitle, "A title");
  assert.equal(CATALOG.rows[0].status, "crystallizing");
  assert.equal(CATALOG.rows[0].lastError, undefined,
    "stale lastError must be cleared when book starts crystallizing");
  assert.equal(CATALOG.rows[1].status, "evaluated", "untouched row");
});

test("[batch-dispatcher] phase='book-start' with non-string bookId leaves current null", () => {
  resetState();
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-start", bookId: 42 }, dummyDeps);
  assert.equal(BATCH.currentBookId, null);
});

/* ─── stage='batch' phase='book-done' ──────────────────────────────── */

test("[batch-dispatcher] phase='book-done' increments done + sets row to indexed + clears lastError", () => {
  resetState();
  CATALOG.rows = [
    { id: "a", title: "A", status: "crystallizing", lastError: "x", wordCount: 1 },
  ];
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-done", bookId: "a" }, dummyDeps);
  assert.equal(BATCH.done, 1);
  assert.equal(CATALOG.rows[0].status, "indexed");
  assert.equal(CATALOG.rows[0].lastError, undefined);
});

test("[batch-dispatcher] book-done with unknown bookId still increments counter", () => {
  resetState();
  CATALOG.rows = [{ id: "a", title: "A", status: "evaluated", wordCount: 1 }];
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-done", bookId: "ghost" }, dummyDeps);
  assert.equal(BATCH.done, 1, "counter incremented even when bookId not in catalog");
  assert.equal(CATALOG.rows[0].status, "evaluated", "real row untouched");
});

/* ─── stage='batch' phase='book-failed' ────────────────────────────── */

test("[batch-dispatcher] phase='book-failed' increments failed + sets row to failed with error", () => {
  resetState();
  CATALOG.rows = [
    { id: "a", title: "A", status: "crystallizing", wordCount: 1 },
  ];
  applyBatchEvent(dummyRoot, {
    stage: "batch", phase: "book-failed", bookId: "a", error: "LLM timeout",
  }, dummyDeps);
  assert.equal(BATCH.failed, 1);
  assert.equal(CATALOG.rows[0].status, "failed");
  assert.equal(CATALOG.rows[0].lastError, "LLM timeout");
});

test("[batch-dispatcher] book-failed without error string leaves lastError undefined (no 'undefined' literal)", () => {
  resetState();
  CATALOG.rows = [{ id: "a", title: "A", status: "crystallizing", wordCount: 1 }];
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-failed", bookId: "a" }, dummyDeps);
  assert.equal(BATCH.failed, 1);
  assert.equal(CATALOG.rows[0].status, "failed");
  assert.equal(CATALOG.rows[0].lastError, undefined,
    "missing error must NOT result in literal string 'undefined' in lastError");
});

/* ─── isolation: non-batch stage ───────────────────────────────────── */

test("[batch-dispatcher] non-batch stage is no-op for batch counters and rows", () => {
  resetState();
  CATALOG.rows = [{ id: "a", title: "A", status: "evaluated", wordCount: 1 }];
  applyBatchEvent(dummyRoot, { stage: "synthesize", phase: "start", total: 999 }, dummyDeps);
  assert.equal(BATCH.total, 0, "synthesize stage must not bleed into batch counters");
  assert.equal(BATCH.done, 0);
  assert.equal(BATCH.failed, 0);
  assert.equal(CATALOG.rows[0].status, "evaluated");
});

/* ─── forward-compat: unknown phase ────────────────────────────────── */

test("[batch-dispatcher] unknown phase inside stage='batch' is ignored without crash", () => {
  resetState();
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "future-phase-unknown", foo: "bar" }, dummyDeps);
  assert.equal(BATCH.done, 0);
  assert.equal(BATCH.failed, 0);
  assert.equal(BATCH.skipped, 0);
  assert.equal(BATCH.total, 0);
});

/* ─── full happy-path sequence ─────────────────────────────────────── */

test("[batch-dispatcher] happy path: start → 2 books → counters consistent + statuses correct", () => {
  resetState();
  CATALOG.rows = [
    { id: "a", title: "A", status: "evaluated", wordCount: 1 },
    { id: "b", title: "B", status: "evaluated", wordCount: 1 },
  ];
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "start", total: 2 }, dummyDeps);
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-start", bookId: "a", bookTitle: "A" }, dummyDeps);
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-done", bookId: "a" }, dummyDeps);
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-start", bookId: "b", bookTitle: "B" }, dummyDeps);
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-failed", bookId: "b", error: "err" }, dummyDeps);

  assert.equal(BATCH.total, 2);
  assert.equal(BATCH.done, 1);
  assert.equal(BATCH.failed, 1);
  assert.equal(BATCH.skipped, 0);
  assert.equal(CATALOG.rows[0].status, "indexed");
  assert.equal(CATALOG.rows[1].status, "failed");
  assert.equal(CATALOG.rows[1].lastError, "err");
});

test("[batch-dispatcher] dispatcher does NOT touch rows that aren't matched by bookId", () => {
  /* Регрессия prevention: легко случайно сделать `for (const r of rows) r.status = ...`
     вместо findIndex(). Тест ловит. */
  resetState();
  CATALOG.rows = [
    { id: "a", title: "A", status: "evaluated", wordCount: 1 },
    { id: "b", title: "B", status: "evaluated", wordCount: 1 },
    { id: "c", title: "C", status: "imported", wordCount: 1 },
  ];
  applyBatchEvent(dummyRoot, { stage: "batch", phase: "book-done", bookId: "a" }, dummyDeps);
  assert.equal(CATALOG.rows[0].status, "indexed");
  assert.equal(CATALOG.rows[1].status, "evaluated", "row b must NOT be flipped");
  assert.equal(CATALOG.rows[2].status, "imported", "row c must NOT be flipped");
});
