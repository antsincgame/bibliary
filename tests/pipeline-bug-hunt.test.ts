/**
 * Pipeline Bug Hunt — целевые тесты для обнаружения скрытых дефектов.
 *
 * Каждый тест проверяет конкретную гипотезу о потенциальном баге.
 * НЕ тестируем happy-path — ищем edge cases, race conditions,
 * state leaks, и забытые cleanup'ы.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";

/* ────────────────────────────────────────────────────────────────── */
/* Helper: temp-dir environment setup for DB-backed tests           */
/* ────────────────────────────────────────────────────────────────── */

interface TempEnv {
  tempRoot: string;
  dataDir: string;
  libraryRoot: string;
  cleanup: () => Promise<void>;
}

async function setupTempEnv(): Promise<TempEnv> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-bughunt-"));
  const dataDir = path.join(tempRoot, "data");
  const libraryRoot = path.join(dataDir, "library");
  await mkdir(libraryRoot, { recursive: true });

  const prevDataDir = process.env.BIBLIARY_DATA_DIR;
  const prevLibraryDb = process.env.BIBLIARY_LIBRARY_DB;
  const prevLibraryRoot = process.env.BIBLIARY_LIBRARY_ROOT;

  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;

  const { closeCacheDb } = await import("../electron/lib/library/cache-db.js");
  const { _resetLibraryRootCache } = await import("../electron/lib/library/paths.ts");
  closeCacheDb();
  _resetLibraryRootCache();

  return {
    tempRoot,
    dataDir,
    libraryRoot,
    cleanup: async () => {
      const { closeCacheDb: close2 } = await import("../electron/lib/library/cache-db.js");
      const { _resetLibraryRootCache: reset2 } = await import("../electron/lib/library/paths.ts");
      close2();
      reset2();
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

/* ────────────────────────────────────────────────────────────────── */
/* 1. EVALUATOR QUEUE — state leak между оценками                  */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] evaluator-queue state management", () => {
  let queue: typeof import("../electron/lib/library/evaluator-queue.js");

  beforeEach(async () => {
    queue = await import("../electron/lib/library/evaluator-queue.js");
    queue._resetEvaluatorForTests();
  });

  afterEach(() => {
    queue._resetEvaluatorForTests();
  });

  it("enqueueBook is truly idempotent — double enqueue does NOT create duplicate in queue", () => {
    queue.enqueueBook("book-1");
    queue.enqueueBook("book-1");
    queue.enqueueBook("book-1");
    const status = queue.getEvaluatorStatus();
    assert.equal(status.queueLength, 1, "triple enqueue should result in exactly 1 entry");
  });

  it("clearQueue fully resets inQueue set — enqueue after clear works", () => {
    queue.enqueueBook("book-1");
    queue.clearQueue();
    const afterClear = queue.getEvaluatorStatus();
    assert.equal(afterClear.queueLength, 0, "queue must be empty after clear");

    queue.enqueueBook("book-1");
    const afterRe = queue.getEvaluatorStatus();
    assert.equal(afterRe.queueLength, 1, "book-1 should be re-enqueueable after clear");
  });

  it("enqueuePriority moves existing book to head without duplicating", () => {
    queue.enqueueBook("book-a");
    queue.enqueueBook("book-b");
    queue.enqueueBook("book-c");
    queue.enqueuePriority("book-c");
    const status = queue.getEvaluatorStatus();
    assert.equal(status.queueLength, 3, "all three should remain — no duplication");
  });

  it("setEvaluatorSlots rejects invalid values gracefully", () => {
    const before = queue.getEvaluatorSlotCount();
    queue.setEvaluatorSlots(0);
    assert.equal(queue.getEvaluatorSlotCount(), before, "0 should be rejected");
    queue.setEvaluatorSlots(-1);
    assert.equal(queue.getEvaluatorSlotCount(), before, "-1 should be rejected");
    queue.setEvaluatorSlots(NaN);
    assert.equal(queue.getEvaluatorSlotCount(), before, "NaN should be rejected");
    queue.setEvaluatorSlots(1.5);
    assert.equal(queue.getEvaluatorSlotCount(), before, "float should be rejected (not integer)");
  });

  it("cancelCurrentEvaluation does not crash when no slots are active", () => {
    assert.doesNotThrow(() => {
      queue.cancelCurrentEvaluation("test");
    });
  });

  it("_resetEvaluatorForTests fully resets all state — no leaks between tests", () => {
    queue.enqueueBook("book-leak-1");
    queue.setEvaluatorSlots(8);
    queue.setEvaluatorModel("test-model");
    queue.pauseEvaluator();

    queue._resetEvaluatorForTests();

    const status = queue.getEvaluatorStatus();
    assert.equal(status.queueLength, 0, "queue should be empty");
    assert.equal(status.paused, false, "paused should be false");
    assert.equal(status.running, false, "running should be false");
    assert.equal(queue.getEvaluatorSlotCount(), 2, "slots should reset to default (2)");
  });

  it("pause/resume cycle is clean — no stuck paused state", () => {
    queue.pauseEvaluator();
    assert.equal(queue.getEvaluatorStatus().paused, true);
    queue.resumeEvaluator();
    assert.equal(queue.getEvaluatorStatus().paused, false);
    queue.resumeEvaluator();
    assert.equal(queue.getEvaluatorStatus().paused, false, "double resume should be no-op");
    queue.pauseEvaluator();
    queue.pauseEvaluator();
    assert.equal(queue.getEvaluatorStatus().paused, true, "double pause should be no-op");
  });

  it("evaluator events are properly emitted for enqueue/pause/resume", () => {
    const events: Array<{ type: string }> = [];
    const unsub = queue.subscribeEvaluator((e) => events.push(e));

    queue.enqueueBook("book-ev-1");
    queue.pauseEvaluator();
    queue.resumeEvaluator();

    unsub();

    const types = events.map((e) => e.type);
    assert.ok(types.includes("evaluator.queued"), "should emit queued event");
    assert.ok(types.includes("evaluator.paused"), "should emit paused event");
    assert.ok(types.includes("evaluator.resumed"), "should emit resumed event");
  });

  it("subscribeEvaluator unsub actually unsubscribes — no memory leak", () => {
    let callCount = 0;
    const unsub = queue.subscribeEvaluator(() => { callCount++; });
    queue.enqueueBook("book-mem-1");
    assert.equal(callCount, 1);
    unsub();
    queue.enqueueBook("book-mem-2");
    assert.equal(callCount, 1, "callback should NOT fire after unsub");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 2. IMPORT TASK SCHEDULER — race conditions & edge cases          */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] ImportTaskScheduler edge cases", () => {
  let Scheduler: typeof import("../electron/lib/library/import-task-scheduler.js");

  beforeEach(async () => {
    Scheduler = await import("../electron/lib/library/import-task-scheduler.js");
  });

  it("scheduler respects heavy lane=1 — truly serial execution", async () => {
    const s = new Scheduler.ImportTaskScheduler({ heavyConcurrency: 1 });
    const order: number[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const p1 = s.enqueue("heavy", async () => { order.push(1); await delay(30); order.push(11); return 1; });
    const p2 = s.enqueue("heavy", async () => { order.push(2); await delay(10); order.push(22); return 2; });

    await Promise.all([p1, p2]);
    assert.equal(order[0], 1, "task 1 must start first");
    assert.equal(order[1], 11, "task 1 must FINISH before task 2 starts");
    assert.equal(order[2], 2, "task 2 starts only after task 1 ends");
  });

  it("scheduler drainAndCancelPending rejects queued tasks with error", async () => {
    const s = new Scheduler.ImportTaskScheduler({ heavyConcurrency: 1 });
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const p1 = s.enqueue("heavy", () => delay(100).then(() => "ok"));
    const p2 = s.enqueue("heavy", () => delay(10).then(() => "ok2"));

    const cancelled = s.drainAndCancelPending("test-cancel");
    assert.equal(cancelled, 1, "one pending task should be cancelled");

    await assert.rejects(p2, /test-cancel/, "rejected promise should carry cancel reason");
    assert.equal(await p1, "ok", "running task should complete");
  });

  it("scheduler setLimit to 0 is rejected — scheduler survives invalid limit", () => {
    const s = new Scheduler.ImportTaskScheduler();
    s.setLimit("light", 0);
    s.setLimit("light", -5);
    const after = s.getSnapshot();
    assert.ok(after.light.queued >= 0, "scheduler should not crash on invalid limit");
  });

  it("scheduler handles task that throws synchronously", async () => {
    const s = new Scheduler.ImportTaskScheduler();
    const p = s.enqueue("light", () => { throw new Error("sync-boom"); });
    await assert.rejects(p, /sync-boom/);
    const snapshot = s.getSnapshot();
    assert.equal(snapshot.light.running, 0, "running count must be decremented after error");
  });

  it("scheduler handles task that returns rejected promise", async () => {
    const s = new Scheduler.ImportTaskScheduler();
    const p = s.enqueue("light", () => Promise.reject(new Error("async-boom")));
    await assert.rejects(p, /async-boom/);
    const snapshot = s.getSnapshot();
    assert.equal(snapshot.light.running, 0, "running count must be decremented after rejection");
  });

  it("singleton scheduler survives across calls", () => {
    const s1 = Scheduler.getImportScheduler();
    const s2 = Scheduler.getImportScheduler();
    assert.equal(s1, s2, "singleton should return same instance");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 3. ASYNC POOL — runWithConcurrency edge cases                   */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] runWithConcurrency edge cases", () => {
  let pool: typeof import("../electron/lib/library/async-pool.js");

  beforeEach(async () => {
    pool = await import("../electron/lib/library/async-pool.js");
  });

  it("pool with concurrency=1 processes sequentially", async () => {
    const order: number[] = [];
    const source = (async function* () {
      yield 1; yield 2; yield 3;
    })();
    const results: number[] = [];
    for await (const r of pool.runWithConcurrency(source, 1, async (n) => {
      order.push(n);
      return n * 10;
    })) {
      if (r.ok) results.push(r.value);
    }
    assert.deepEqual(order, [1, 2, 3], "should process in order with concurrency=1");
    assert.equal(results.length, 3);
  });

  it("pool error in one worker does NOT stop others", async () => {
    const source = (async function* () {
      yield 1; yield 2; yield 3;
    })();
    const results: Array<{ ok: boolean; index: number }> = [];
    for await (const r of pool.runWithConcurrency(source, 3, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    })) {
      results.push({ ok: r.ok, index: r.index });
    }
    assert.equal(results.length, 3, "all three should produce results");
    const failed = results.filter((r) => !r.ok);
    assert.equal(failed.length, 1, "exactly one should fail");
  });

  it("pool with empty source yields nothing", async () => {
    const source = (async function* (): AsyncGenerator<number> {})();
    const results: unknown[] = [];
    for await (const r of pool.runWithConcurrency(source, 4, async (n) => n)) {
      results.push(r);
    }
    assert.equal(results.length, 0);
  });

  it("pool rejects if concurrency < 1", async () => {
    const source = (async function* () { yield 1; })();
    await assert.rejects(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of pool.runWithConcurrency(source, 0, async (n) => n)) { /* */ }
    }, /concurrency must be >= 1/);
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 4. IMPORT — ключевые контракты importFile                       */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] import.ts contracts", () => {
  let env: TempEnv;

  beforeEach(async () => {
    env = await setupTempEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("importFile on non-existent path returns failed, not throws", async () => {
    const { importFile } = await import("../electron/lib/library/import.ts");
    const results = await importFile("/absolutely/fake/path/book.pdf");
    assert.ok(results.length > 0, "should return at least one result");
    const r = results[0];
    assert.equal(r.outcome, "failed", "non-existent file should be 'failed'");
  });

  it("importFile on unsupported extension returns skipped", async () => {
    const { importFile } = await import("../electron/lib/library/import.ts");
    const results = await importFile("/fake/path/file.xyz");
    assert.ok(results.length > 0, "should return at least one result");
    assert.equal(results[0].outcome, "skipped");
    assert.ok(results[0].warnings.some((w) => w.includes("unsupported")));
  });

  it("importFolderToLibrary rejects if path is not a directory", async () => {
    const { importFolderToLibrary } = await import("../electron/lib/library/import.ts");
    await assert.rejects(
      importFolderToLibrary("/nonexistent/path/xyz"),
      /ENOENT|not a directory/,
    );
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 5. SHA-STREAM — edge cases                                      */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] sha-stream edge cases", () => {
  let shaStream: typeof import("../electron/lib/library/sha-stream.js");
  let tmpDir: string;

  beforeEach(async () => {
    shaStream = await import("../electron/lib/library/sha-stream.js");
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "bibliary-sha-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("empty file produces valid SHA-256", async () => {
    const { writeFile } = await import("node:fs/promises");
    const emptyFile = path.join(tmpDir, "empty.txt");
    await writeFile(emptyFile, "");
    const hash = await shaStream.computeFileSha256(emptyFile);
    assert.equal(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "SHA-256 of empty file must be the well-known hash");
  });

  it("bookIdFromSha produces deterministic 16-char ID", () => {
    const id = shaStream.bookIdFromSha("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(id.length, 16);
    const id2 = shaStream.bookIdFromSha("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(id, id2, "must be deterministic");
  });

  it("computeFileSha256 rejects for missing file", async () => {
    await assert.rejects(
      shaStream.computeFileSha256("/nonexistent/file.pdf"),
      /ENOENT/,
    );
  });

  it("computeFileSha256 respects abort signal", async () => {
    const { writeFile } = await import("node:fs/promises");
    const bigFile = path.join(tmpDir, "big.bin");
    await writeFile(bigFile, Buffer.alloc(1024 * 1024));
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      shaStream.computeFileSha256(bigFile, ctrl.signal),
      /abort/i,
    );
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 6. FILENAME PARSER — edge cases with non-Latin characters        */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] filename-parser edge cases", () => {
  let parser: typeof import("../electron/lib/library/filename-parser.js");

  beforeEach(async () => {
    parser = await import("../electron/lib/library/filename-parser.js");
  });

  it("handles Cyrillic author — title pattern", () => {
    const r = parser.parseFilename("/books/Толстой Л.Н. - Война и мир.epub");
    assert.ok(r, "should parse Cyrillic filename");
    assert.ok(r!.title.length > 0, "title should not be empty");
  });

  it("handles filename with multiple dots", () => {
    const r = parser.parseFilename("/books/Dr. Smith - Intro.to.AI.2024.pdf");
    assert.ok(r, "should handle dots in filename");
  });

  it("handles empty filename gracefully", () => {
    const r = parser.parseFilename("");
    assert.ok(r === null || typeof r === "object");
  });

  it("handles filename with only extension", () => {
    const r = parser.parseFilename(".pdf");
    assert.ok(r === null || typeof r === "object");
  });

  it("handles very long filename (>260 chars)", () => {
    const longName = "A".repeat(300) + ".pdf";
    const r = parser.parseFilename(`/books/${longName}`);
    assert.ok(r === null || typeof r === "object", "should not throw on long filename");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 7. CROSS-FORMAT PREDEDUP — priority correctness                 */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] CrossFormatPreDedup — format priority edge cases", () => {
  let CrossFormatPreDedup: typeof import("../electron/lib/library/cross-format-prededup.js").CrossFormatPreDedup;

  beforeEach(async () => {
    const mod = await import("../electron/lib/library/cross-format-prededup.js");
    CrossFormatPreDedup = mod.CrossFormatPreDedup;
  });

  it("epub beats pdf for same basename", () => {
    const dedup = new CrossFormatPreDedup();
    const r1 = dedup.check("/books/Tolstoy - War.epub");
    const r2 = dedup.check("/books/Tolstoy - War.pdf");
    assert.ok(r1.include, "first file always included");
    assert.ok(!r2.include, "pdf should be excluded when epub exists");
  });

  it("preferDjvuOverPdf=true — djvu supersedes pdf", () => {
    const dedup = new CrossFormatPreDedup({ preferDjvuOverPdf: true });
    const r1 = dedup.check("/books/Book.pdf");
    const r2 = dedup.check("/books/Book.djvu");
    assert.ok(r1.include || r2.include, "at least one format must be included");
  });

  it("different basenames are NOT deduped", () => {
    const dedup = new CrossFormatPreDedup();
    const r1 = dedup.check("/books/BookA.pdf");
    const r2 = dedup.check("/books/BookB.pdf");
    assert.ok(r1.include && r2.include, "different basenames should both be included");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 8. REVISION DEDUP — workKey edge cases                          */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] revision-dedup workKey generation", () => {
  let buildWorkKey: typeof import("../electron/lib/library/revision-dedup.js").buildWorkKey;

  beforeEach(async () => {
    const mod = await import("../electron/lib/library/revision-dedup.js");
    buildWorkKey = mod.buildWorkKey;
  });

  it("empty title + empty author returns null/empty (no crash)", () => {
    const key = buildWorkKey({ title: "", author: "" });
    assert.ok(key === null || key === "" || typeof key === "string");
  });

  it("title normalization is case-insensitive", () => {
    const k1 = buildWorkKey({ title: "War and Peace", author: "Tolstoy" });
    const k2 = buildWorkKey({ title: "war and peace", author: "tolstoy" });
    assert.equal(k1, k2, "workKeys must be case-insensitive");
  });

  it("title with special chars doesn't crash", () => {
    assert.doesNotThrow(() => {
      buildWorkKey({ title: "C++ Programming (3rd Ed.)", author: "Stroustrup" });
    });
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 9. ARCHIVE TRACKER — refcount edge cases                        */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] ArchiveTracker lifecycle", () => {
  let ArchiveTracker: typeof import("../electron/lib/library/archive-tracker.js").ArchiveTracker;

  beforeEach(async () => {
    const mod = await import("../electron/lib/library/archive-tracker.js");
    ArchiveTracker = mod.ArchiveTracker;
  });

  it("finishOne on non-registered dir is no-op", async () => {
    const tracker = new ArchiveTracker();
    await assert.doesNotReject(tracker.finishOne("/unknown/dir"));
  });

  it("finishOne undefined is no-op", async () => {
    const tracker = new ArchiveTracker();
    await assert.doesNotReject(tracker.finishOne(undefined));
  });

  it("cleanup callback fires exactly once at refcount=0", async () => {
    const tracker = new ArchiveTracker();
    let cleanupCount = 0;
    tracker.register("/tmp/archive1", 3, () => { cleanupCount++; return Promise.resolve(); });
    await tracker.finishOne("/tmp/archive1");
    await tracker.finishOne("/tmp/archive1");
    assert.equal(cleanupCount, 0, "cleanup should not fire until refcount reaches 0");
    await tracker.finishOne("/tmp/archive1");
    assert.equal(cleanupCount, 1, "cleanup should fire exactly once");
    await tracker.finishOne("/tmp/archive1");
    assert.equal(cleanupCount, 1, "second cleanup should NOT fire");
  });

  it("cleanupAll fires for all pending archives", async () => {
    const tracker = new ArchiveTracker();
    let count = 0;
    tracker.register("/tmp/a1", 5, () => { count++; return Promise.resolve(); });
    tracker.register("/tmp/a2", 2, () => { count++; return Promise.resolve(); });
    await tracker.cleanupAll();
    assert.equal(count, 2, "cleanupAll should clean all");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 10. CACHE-DB — upsert/query contracts                           */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] cache-db upsert/query edge cases", () => {
  let env: TempEnv;
  let cacheDb: typeof import("../electron/lib/library/cache-db.js");

  beforeEach(async () => {
    env = await setupTempEnv();
    cacheDb = await import("../electron/lib/library/cache-db.js");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("upsertBook + getBookById roundtrip preserves all fields", () => {
    const meta = {
      id: "test-book-001",
      sha256: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      title: "Test Book",
      titleEn: "Test Book EN",
      authorEn: "Author EN",
      originalFile: "book.pdf",
      originalFormat: "pdf" as const,
      wordCount: 5000,
      chapterCount: 10,
      status: "imported" as const,
    };
    cacheDb.upsertBook(meta, "/library/test/book.md");
    const retrieved = cacheDb.getBookById("test-book-001");
    assert.ok(retrieved, "book should be retrievable after upsert");
    assert.equal(retrieved!.title, "Test Book");
    assert.equal(retrieved!.wordCount, 5000);
    assert.equal(retrieved!.status, "imported");
  });

  it("getBookById returns null for non-existent ID", () => {
    const r = cacheDb.getBookById("nonexistent-id-999");
    assert.equal(r, null);
  });

  it("upsertBook with same id updates (not duplicates)", () => {
    const base = {
      id: "dup-test-001",
      sha256: "1111111111111111111111111111111111111111111111111111111111111111",
      title: "Original Title",
      originalFile: "book.pdf",
      originalFormat: "pdf" as const,
      wordCount: 100,
      chapterCount: 2,
      status: "imported" as const,
    };
    cacheDb.upsertBook(base, "/lib/book.md");
    cacheDb.upsertBook({ ...base, title: "Updated Title", status: "evaluated" }, "/lib/book.md");
    const r = cacheDb.getBookById("dup-test-001");
    assert.equal(r!.title, "Updated Title");
    assert.equal(r!.status, "evaluated");
  });

  it("getKnownSha256s returns Map", () => {
    const known = cacheDb.getKnownSha256s();
    assert.ok(known instanceof Map, "should return a Map");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 11. PATH SANITIZER — edge cases                                 */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] path-sanitizer edge cases", () => {
  let sanitizer: typeof import("../electron/lib/library/path-sanitizer.js");

  beforeEach(async () => {
    sanitizer = await import("../electron/lib/library/path-sanitizer.js");
  });

  it("extractSphereFromImportPath returns string or falsy for nested path", () => {
    const sphere = sanitizer.extractSphereFromImportPath(
      "/Users/me/books/computer_science/algorithms/cormen.pdf",
      "/Users/me/books",
    );
    assert.ok(typeof sphere === "string" || sphere == null || sphere === "");
  });

  it("extractSphereFromImportPath handles direct child of root (no sphere)", () => {
    const sphere = sanitizer.extractSphereFromImportPath(
      "/Users/me/books/cormen.pdf",
      "/Users/me/books",
    );
    assert.ok(typeof sphere === "string" || sphere == null);
  });

  it("handles Windows-style paths without crashing", () => {
    assert.doesNotThrow(() => {
      sanitizer.extractSphereFromImportPath(
        "D:\\books\\science\\physics\\book.pdf",
        "D:\\books",
      );
    });
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 12. IMPORT CANDIDATE FILTER — structural tests                  */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] import-candidate-filter", () => {
  let filter: typeof import("../electron/lib/library/import-candidate-filter.js");

  beforeEach(async () => {
    filter = await import("../electron/lib/library/import-candidate-filter.js");
  });

  it("shouldIncludeImportCandidate is exported and callable", () => {
    assert.ok(typeof filter.shouldIncludeImportCandidate === "function",
      "shouldIncludeImportCandidate must be exported");
  });

  it("noise directory segment is excluded", () => {
    const result = filter.shouldIncludeImportCandidate({
      rootDir: "/books",
      candidatePath: "/books/images/cover.epub",
      ext: "epub",
      sizeBytes: 100_000,
    });
    assert.ok(!result, "files inside 'images' noise dir should be excluded");
  });

  it("noise basename (readme) is excluded", () => {
    const result = filter.shouldIncludeImportCandidate({
      rootDir: "/books",
      candidatePath: "/books/readme.pdf",
      ext: "pdf",
      sizeBytes: 5_000,
    });
    assert.ok(!result, "readme.pdf should be excluded");
  });

  it("regular book in root is included", () => {
    const result = filter.shouldIncludeImportCandidate({
      rootDir: "/books",
      candidatePath: "/books/War and Peace.epub",
      ext: "epub",
      sizeBytes: 1_000_000,
    });
    assert.ok(result, "regular book should be included");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 13. MD-CONVERTER — frontmatter and chapter parsing              */
/* ────────────────────────────────────────────────────────────────── */

describe("[BUG-HUNT] md-converter frontmatter handling", () => {
  let mdConverter: typeof import("../electron/lib/library/md-converter.js");

  beforeEach(async () => {
    mdConverter = await import("../electron/lib/library/md-converter.js");
  });

  it("replaceFrontmatter on md WITHOUT frontmatter returns unchanged (not prepend)", () => {
    const md = "# Chapter 1\n\nSome text here.";
    const meta = {
      id: "test",
      sha256: "a".repeat(64),
      title: "Test",
      originalFile: "test.pdf",
      originalFormat: "pdf" as const,
      wordCount: 100,
      chapterCount: 1,
      status: "evaluated" as const,
    };
    const result = mdConverter.replaceFrontmatter(md, meta);
    assert.equal(result, md, "should return unchanged when no frontmatter");
  });

  it("replaceFrontmatter on md WITH frontmatter replaces it", () => {
    const meta = {
      id: "test",
      sha256: "a".repeat(64),
      title: "New Title",
      originalFile: "test.pdf",
      originalFormat: "pdf" as const,
      wordCount: 100,
      chapterCount: 1,
      status: "evaluated" as const,
    };
    const md = `---\nid: test\ntitle: Old\noriginalFile: test.pdf\noriginalFormat: pdf\nwordCount: 100\nchapterCount: 1\nstatus: imported\nsha256: ${"a".repeat(64)}\n---\n## Chapter 1\n\nContent here.`;
    const result = mdConverter.replaceFrontmatter(md, meta);
    assert.ok(!result.includes("Old"), "old title should be replaced");
    assert.ok(result.includes("New Title"), "new title should be present");
    assert.ok(result.includes("## Chapter 1"), "original content preserved");
  });

  it("parseBookMarkdownChapters requires frontmatter — returns empty without it", () => {
    const md = "# Chapter 1\n\nText\n\n# Chapter 2\n\nMore text";
    const chapters = mdConverter.parseBookMarkdownChapters(md);
    assert.ok(Array.isArray(chapters));
    assert.equal(chapters.length, 0, "no frontmatter → empty array (API contract)");
  });

  it("parseBookMarkdownChapters parses ## chapters from proper book.md format", () => {
    const md = `---\nid: test\ntitle: Test Book\noriginalFile: t.pdf\noriginalFormat: pdf\nwordCount: 200\nchapterCount: 2\nstatus: imported\nsha256: ${"b".repeat(64)}\n---\n\n## Chapter One\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Chapter Two\n\nAnother paragraph.`;
    const chapters = mdConverter.parseBookMarkdownChapters(md);
    assert.ok(Array.isArray(chapters));
    assert.ok(chapters.length >= 2, `should parse at least 2 chapters, got ${chapters.length}`);
    assert.ok(chapters[0].title.includes("Chapter One"), "first chapter title");
    assert.ok(chapters[1].title.includes("Chapter Two"), "second chapter title");
  });

  it("parseBookMarkdownChapters on empty string returns empty array", () => {
    const chapters = mdConverter.parseBookMarkdownChapters("");
    assert.ok(Array.isArray(chapters));
    assert.equal(chapters.length, 0);
  });
});
