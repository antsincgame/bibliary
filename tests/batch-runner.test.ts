/* Cover the pure batch-extract core: gate filtering, status updates, error recovery, cancel. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { closeCacheDb, upsertBook, getBookById, setBookStatus } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import {
  runBatchExtraction,
  type BatchExtractionResult,
  type BatchRunnerDeps,
} from "../electron/lib/library/batch-runner.ts";
import { resolveStoredBookPaths } from "../electron/lib/library/storage-contract.ts";
import type { BookCatalogMeta } from "../electron/lib/library/types.ts";

interface TestEnv {
  libraryRoot: string;
  cleanup: () => Promise<void>;
}

async function setupTestEnv(): Promise<TestEnv> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-batch-"));
  const dataDir = path.join(tempRoot, "data");
  const libraryRoot = path.join(dataDir, "library");

  const prevDataDir = process.env.BIBLIARY_DATA_DIR;
  const prevLibraryDb = process.env.BIBLIARY_LIBRARY_DB;
  const prevLibraryRoot = process.env.BIBLIARY_LIBRARY_ROOT;

  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;

  closeCacheDb();
  _resetLibraryRootCache();

  return {
    libraryRoot,
    cleanup: async () => {
      closeCacheDb();
      _resetLibraryRootCache();
      if (prevDataDir === undefined) delete process.env.BIBLIARY_DATA_DIR;
      else process.env.BIBLIARY_DATA_DIR = prevDataDir;
      if (prevLibraryDb === undefined) delete process.env.BIBLIARY_LIBRARY_DB;
      else process.env.BIBLIARY_LIBRARY_DB = prevLibraryDb;
      if (prevLibraryRoot === undefined) delete process.env.BIBLIARY_LIBRARY_ROOT;
      else process.env.BIBLIARY_LIBRARY_ROOT = prevLibraryRoot;
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function makeMeta(
  id: string,
  overrides: Partial<BookCatalogMeta> = {},
): BookCatalogMeta {
  return {
    id,
    sha256: id.padEnd(64, "0"),
    title: `Book ${id}`,
    originalFile: "original.pdf",
    originalFormat: "pdf",
    wordCount: 5000,
    chapterCount: 10,
    qualityScore: 85,
    isFictionOrWater: false,
    status: "evaluated",
    ...overrides,
  };
}

function fakeExtraction(stats: {
  accepted: number;
  rejected: number;
  extracted: number;
}): BatchExtractionResult {
  return {
    jobId: "job-fake",
    bookTitle: "Fake Book",
    totalChapters: 5,
    processedChapters: 5,
    totalDelta: {
      chunks: stats.extracted,
      accepted: stats.accepted,
      skipped: stats.rejected,
    },
    warnings: [],
  };
}

function makeDeps(overrides: Partial<BatchRunnerDeps> = {}): BatchRunnerDeps & {
  _events: Record<string, unknown>[];
  _statusCalls: Array<{ id: string; status: string; extras?: unknown }>;
} {
  const _events: Record<string, unknown>[] = [];
  const _statusCalls: Array<{ id: string; status: string; extras?: unknown }> = [];
  return {
    getBookById,
    setBookStatus: (id, status, extras) => {
      _statusCalls.push({ id, status, extras });
      return setBookStatus(id, status, extras);
    },
    runExtraction: async () => fakeExtraction({ accepted: 4, rejected: 1, extracted: 6 }),
    emit: (e) => _events.push(e),
    cancelSignal: new AbortController().signal,
    ...overrides,
    _events,
    _statusCalls,
  };
}

test("runBatchExtraction filters out books that fail the gate", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const lowQ = makeMeta("11111111111111aa", { qualityScore: 40 });
  const fiction = makeMeta("22222222222222aa", { isFictionOrWater: true });
  const notEvaluated = makeMeta("33333333333333aa", { status: "imported", qualityScore: undefined });
  const ok = makeMeta("44444444444444aa", { qualityScore: 90 });

  for (const m of [lowQ, fiction, notEvaluated, ok]) {
    const stored = resolveStoredBookPaths(env.libraryRoot, m.id, m.originalFormat);
    upsertBook(m, stored.mdPath);
  }

  let extractionRan = 0;
  const deps = makeDeps({
    runExtraction: async (_args, ctx) => {
      extractionRan += 1;
      assert.equal(ctx.bookId, ok.id, "only the eligible book runs");
      return fakeExtraction({ accepted: 3, rejected: 0, extracted: 5 });
    },
  });

  const summary = await runBatchExtraction(
    {
      bookIds: [lowQ.id, fiction.id, notEvaluated.id, ok.id],
      minQuality: 70,
      targetCollection: "test-coll",
      batchId: "batch-filter",
    },
    deps,
  );

  assert.equal(extractionRan, 1, "only eligible book extracted");
  assert.equal(summary.processed, 1);
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].bookId, ok.id);
  assert.equal(summary.skipped.length, 3);

  const reasons = new Map(summary.skipped.map((s) => [s.bookId, s.reason]));
  assert.match(reasons.get(lowQ.id) ?? "", /qualityScore=40/);
  assert.equal(reasons.get(fiction.id), "is_fiction_or_water");
  assert.match(reasons.get(notEvaluated.id) ?? "", /must be evaluated/);

  const filtered = deps._events.find((e) => e.phase === "filtered");
  assert.ok(filtered, "filtered event emitted");
  assert.equal(filtered?.eligible, 1);
  assert.equal(filtered?.skipped, 3);
});

test("runBatchExtraction supports skipFictionOrWater=false", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const fiction = makeMeta("aaaaaaaaaaaaaaaa", { isFictionOrWater: true });
  const stored = resolveStoredBookPaths(env.libraryRoot, fiction.id, fiction.originalFormat);
  upsertBook(fiction, stored.mdPath);

  let ran = false;
  const deps = makeDeps({
    runExtraction: async () => {
      ran = true;
      return fakeExtraction({ accepted: 1, rejected: 0, extracted: 2 });
    },
  });

  const summary = await runBatchExtraction(
    {
      bookIds: [fiction.id],
      skipFictionOrWater: false,
      targetCollection: "test-coll",
      batchId: "batch-fic",
    },
    deps,
  );

  assert.equal(ran, true, "fiction book accepted when skip flag off");
  assert.equal(summary.processed, 1);
});

test("runBatchExtraction skips not-found ids without throwing", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const summary = await runBatchExtraction(
    {
      bookIds: ["nonexistent000001", "nonexistent000002"],
      targetCollection: "test-coll",
      batchId: "batch-nf",
    },
    makeDeps(),
  );

  assert.equal(summary.processed, 0);
  assert.equal(summary.skipped.length, 2);
  assert.ok(summary.skipped.every((s) => s.reason === "not-found"));
});

test("runBatchExtraction sets crystallizing → indexed on success", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeMeta("bbbbbbbbbbbbbbbb");
  const stored = resolveStoredBookPaths(env.libraryRoot, book.id, book.originalFormat);
  upsertBook(book, stored.mdPath);

  const deps = makeDeps({
    runExtraction: async () => fakeExtraction({ accepted: 7, rejected: 2, extracted: 12 }),
  });

  await runBatchExtraction(
    {
      bookIds: [book.id],
      targetCollection: "test-coll",
      batchId: "batch-success",
    },
    deps,
  );

  const calls = deps._statusCalls.filter((c) => c.id === book.id);
  assert.equal(calls.length, 2, "two status updates: crystallizing then indexed");
  assert.equal(calls[0].status, "crystallizing");
  assert.equal(calls[1].status, "indexed");
  assert.deepEqual(calls[1].extras, { conceptsAccepted: 7, conceptsExtracted: 12 });

  const cached = getBookById(book.id);
  assert.equal(cached?.status, "indexed");
});

test("runBatchExtraction marks book 'failed' on extraction error and continues", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const a = makeMeta("cccccccccccccccc");
  const b = makeMeta("dddddddddddddddd");
  for (const m of [a, b]) {
    const stored = resolveStoredBookPaths(env.libraryRoot, m.id, m.originalFormat);
    upsertBook(m, stored.mdPath);
  }

  let i = 0;
  const deps = makeDeps({
    runExtraction: async () => {
      i += 1;
      if (i === 1) throw new Error("simulated parse failure");
      return fakeExtraction({ accepted: 2, rejected: 0, extracted: 3 });
    },
  });

  const summary = await runBatchExtraction(
    {
      bookIds: [a.id, b.id],
      targetCollection: "test-coll",
      batchId: "batch-err",
    },
    deps,
  );

  assert.equal(summary.processed, 1, "second book succeeded");
  assert.equal(summary.results[0].bookId, b.id);
  assert.equal(summary.skipped.length, 1);
  assert.match(summary.skipped[0].reason, /extraction-failed: simulated parse failure/);

  const cachedA = getBookById(a.id);
  const cachedB = getBookById(b.id);
  assert.equal(cachedA?.status, "failed", "first book marked failed in cache");
  assert.equal(cachedB?.status, "indexed");

  const failedEvent = deps._events.find((e) => e.phase === "book-failed");
  assert.ok(failedEvent);
  assert.equal(failedEvent?.bookId, a.id);
});

test("runBatchExtraction: cancellation marks remaining books as batch-cancelled", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const a = makeMeta("eeeeeeeeeeeeeeee");
  const b = makeMeta("ffffffffffffffff");
  const c = makeMeta("9999999999999999");
  for (const m of [a, b, c]) {
    const stored = resolveStoredBookPaths(env.libraryRoot, m.id, m.originalFormat);
    upsertBook(m, stored.mdPath);
  }

  const ctrl = new AbortController();
  let processed = 0;
  const deps = makeDeps({
    cancelSignal: ctrl.signal,
    runExtraction: async () => {
      processed += 1;
      if (processed === 1) {
        /* После первой книги отменяем -- цикл должен выйти на следующей итерации. */
        ctrl.abort("test-cancel");
      }
      return fakeExtraction({ accepted: 1, rejected: 0, extracted: 1 });
    },
  });

  const summary = await runBatchExtraction(
    {
      bookIds: [a.id, b.id, c.id],
      targetCollection: "test-coll",
      batchId: "batch-cancel",
    },
    deps,
  );

  assert.equal(processed, 1, "extraction stopped after cancel");
  assert.equal(summary.processed, 1);
  assert.equal(summary.skipped.length, 2);
  assert.ok(summary.skipped.every((s) => s.reason === "batch-cancelled"));
  const doneEvent = deps._events.find((e) => e.phase === "done");
  assert.equal(doneEvent?.cancelled, true);
});

test("runBatchExtraction emits events with correct sequence and counts", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const a = makeMeta("00000000000000aa");
  const b = makeMeta("00000000000000bb");
  for (const m of [a, b]) {
    const stored = resolveStoredBookPaths(env.libraryRoot, m.id, m.originalFormat);
    upsertBook(m, stored.mdPath);
  }

  const deps = makeDeps();
  await runBatchExtraction(
    {
      bookIds: [a.id, b.id],
      targetCollection: "marketing",
      batchId: "batch-events",
    },
    deps,
  );

  const phases = deps._events.map((e) => e.phase);
  assert.deepEqual(phases.slice(0, 2), ["start", "filtered"]);
  assert.equal(deps._events[0].targetCollection, "marketing");
  assert.equal(deps._events[0].minQuality, 0, "default minQuality is 0 (UI/confirm gates quality)");

  /* book-start, book-done пары для каждой книги, затем done. */
  const bookStarts = deps._events.filter((e) => e.phase === "book-start");
  const bookDones = deps._events.filter((e) => e.phase === "book-done");
  assert.equal(bookStarts.length, 2);
  assert.equal(bookDones.length, 2);
  assert.equal(bookStarts[0].bookIndex, 1);
  assert.equal(bookStarts[1].bookIndex, 2);
  assert.equal(bookStarts[0].bookTotal, 2);

  const last = deps._events[deps._events.length - 1];
  assert.equal(last.phase, "done");
  assert.equal(last.processed, 2);
  assert.equal(last.cancelled, false);
});

test("runBatchExtraction passes correct context (bookId/index/total) to runExtraction", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const a = makeMeta("ababababababaaaa");
  const b = makeMeta("babababababaaaaa");
  for (const m of [a, b]) {
    const stored = resolveStoredBookPaths(env.libraryRoot, m.id, m.originalFormat);
    upsertBook(m, stored.mdPath);
  }

  const seen: Array<{ bookId: string; bookIndex: number; bookTotal: number }> = [];
  const deps = makeDeps({
    runExtraction: async (_args, ctx) => {
      seen.push({ ...ctx });
      return fakeExtraction({ accepted: 1, rejected: 0, extracted: 1 });
    },
  });

  await runBatchExtraction(
    {
      bookIds: [a.id, b.id],
      targetCollection: "test-coll",
      batchId: "batch-ctx",
    },
    deps,
  );

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { bookId: a.id, bookIndex: 1, bookTotal: 2 });
  assert.deepEqual(seen[1], { bookId: b.id, bookIndex: 2, bookTotal: 2 });
});

test("runBatchExtraction respects custom minQuality", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const m = makeMeta("00000000000000ee", { qualityScore: 60 });
  const stored = resolveStoredBookPaths(env.libraryRoot, m.id, m.originalFormat);
  upsertBook(m, stored.mdPath);

  /* minQuality=50 -- 60 проходит. */
  const deps = makeDeps();
  const summary = await runBatchExtraction(
    {
      bookIds: [m.id],
      minQuality: 50,
      targetCollection: "t",
      batchId: "batch-q",
    },
    deps,
  );
  assert.equal(summary.processed, 1);

  /* Reset для второго прогона: ставим crystallizing/indexed обратно в evaluated. */
  setBookStatus(m.id, "evaluated");
  const summary2 = await runBatchExtraction(
    {
      bookIds: [m.id],
      minQuality: 80,
      targetCollection: "t",
      batchId: "batch-q2",
    },
    makeDeps(),
  );
  assert.equal(summary2.processed, 0);
  assert.match(summary2.skipped[0].reason, /qualityScore=60 < 80/);
});
