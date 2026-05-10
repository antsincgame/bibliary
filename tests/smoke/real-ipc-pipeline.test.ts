/**
 * tests/smoke/real-ipc-pipeline.test.ts
 *
 * Main-process integration smoke без UI и без harness. Закрывает gap из
 * аудита 2026-05-09 (B.6): существующий import-flow.test.ts проверяет
 * import до SQLite + markdown, но НЕ проверяет evaluator-queue follow-up.
 * Реальный production-bug: import успешен, но enqueue не сработал —
 * книга остаётся в `imported` навечно.
 *
 * Этот spec прогоняет полный pipeline:
 *   1. importBookFromFile (.txt fixture)
 *   2. enqueueBook → evaluator-queue (без LLM, ожидаем deferral)
 *   3. Проверяем что evaluator-queue корректно реагирует на отсутствие
 *      модели — book.status остаётся imported, evaluator.skipped event,
 *      lastError описательный.
 *
 * Зачем: даёт гарантию что цепочка import → catalog query → enqueue →
 * evaluator-queue handles собирается без ошибок типизации/импортов и
 * работает с реальной cache.db + реальным book.md на диске.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";

test("[real-ipc] import → catalog → evaluator deferral (no UI, no harness)", async (t) => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-real-ipc-"));
  const dataDir = path.join(tmpRoot, "data");
  const libraryRoot = path.join(tmpRoot, "library");
  await mkdir(dataDir, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  const prevEnv = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;

  t.after(async () => {
    try {
      const { _resetEvaluatorForTests } = await import("../../electron/lib/library/evaluator-queue.ts");
      _resetEvaluatorForTests();
    } catch { /* tolerate */ }
    try {
      const { closeCacheDb } = await import("../../electron/lib/library/cache-db.ts");
      closeCacheDb();
    } catch { /* tolerate */ }
    if (prevEnv.BIBLIARY_DATA_DIR === undefined) delete process.env.BIBLIARY_DATA_DIR;
    else process.env.BIBLIARY_DATA_DIR = prevEnv.BIBLIARY_DATA_DIR;
    if (prevEnv.BIBLIARY_LIBRARY_DB === undefined) delete process.env.BIBLIARY_LIBRARY_DB;
    else process.env.BIBLIARY_LIBRARY_DB = prevEnv.BIBLIARY_LIBRARY_DB;
    if (prevEnv.BIBLIARY_LIBRARY_ROOT === undefined) delete process.env.BIBLIARY_LIBRARY_ROOT;
    else process.env.BIBLIARY_LIBRARY_ROOT = prevEnv.BIBLIARY_LIBRARY_ROOT;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /* ── Setup ── */
  const { initPreferencesStore } = await import("../../electron/lib/preferences/store.ts");
  await initPreferencesStore(dataDir);

  const fixtureDir = path.join(tmpRoot, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, "real-ipc-book.txt");
  const body = [
    "Real IPC Smoke Book",
    "by Pipeline Verification",
    "",
    "Chapter 1: Bootstrap",
    "",
    "This chapter has enough body content to satisfy the chapter-count gate.",
    "We need real text so the parser produces non-zero chapters and word count.",
    "",
    "Chapter 2: Pipeline",
    "",
    "Second chapter ensures the chunker produces multiple boundary points.",
    "Real-world books have multiple chapters; we must mirror that here.",
  ].join("\n");
  await writeFile(fixturePath, body, "utf-8");

  /* ── Step 1: import ── */
  const { importBookFromFile } = await import("../../electron/lib/library/import-book.ts");
  const importResult = await importBookFromFile(fixturePath, {
    ocrEnabled: false,
    visionMetaEnabled: false,
    metadataOnlineLookup: false,
    importRoot: libraryRoot,
  });
  assert.ok(
    importResult.outcome === "added" || importResult.outcome === "imported",
    `import outcome must be added/imported, got ${importResult.outcome}: ${importResult.error ?? ""}`,
  );
  assert.ok(importResult.bookId, "bookId returned");
  const bookId = importResult.bookId!;

  /* ── Step 2: catalog query — реальная DB ── */
  const { query, getBookById } = await import("../../electron/lib/library/cache-db.ts");
  const catalog = query({});
  assert.ok(catalog.rows.length >= 1, "catalog must contain at least 1 row");
  const found = catalog.rows.find((b) => b.id === bookId);
  assert.ok(found, "imported book must be in catalog");
  assert.equal(found!.status, "imported", "book starts in `imported` status (not yet evaluated)");

  /* ── Step 3: evaluator-queue enqueue → ожидаем deferral (нет LLM) ── */
  const {
    _resetEvaluatorForTests,
    _setEvaluatorDepsForTests,
    enqueueBook,
    getEvaluatorStatus,
    subscribeEvaluator,
  } = await import("../../electron/lib/library/evaluator-queue.ts");
  _resetEvaluatorForTests();

  /* DI hook: pickEvaluatorModel вернёт null (нет загруженной LLM в LM Studio).
     Это ровно тот сценарий, который встречает пользователь, у которого
     LM Studio не запущен. Ожидаем graceful deferral. */
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => null,
    evaluateBook: async () => {
      throw new Error("evaluateBook must NOT be called when no model loaded");
    },
  });

  const events: Array<{ type: string; bookId?: string; error?: string }> = [];
  const unsub = subscribeEvaluator((e) => events.push({
    type: e.type,
    bookId: e.bookId,
    error: e.error,
  }));

  enqueueBook(bookId);

  /* Ждём idle (deferral handled). */
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const s = getEvaluatorStatus();
    if (!s.running && s.queueLength === 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  unsub();

  /* ── Step 4: проверяем follow-up state ── */
  const finalMeta = getBookById(bookId);
  assert.ok(finalMeta, "book still in DB");
  assert.equal(finalMeta!.status, "imported",
    "deferred book stays in `imported` (НЕ failed) — backoff retry contract");
  assert.match(finalMeta!.lastError ?? "", /no LLM loaded|deferred/i,
    "lastError describes deferral reason for UI");

  const skippedEvent = events.find((e) => e.type === "evaluator.skipped" && e.bookId === bookId);
  assert.ok(skippedEvent,
    `evaluator.skipped event must fire for deferred book, got events: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.match(skippedEvent!.error ?? "", /no LLM loaded|deferred/i);
});

test("[real-ipc] import → enqueue → cancel → status reverts to imported", async (t) => {
  /* Регрессия: cancel via cancelCurrentEvaluation должен вернуть книгу в
     imported status, чтобы её можно было заново enqueue без manual reset. */
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-real-ipc-cancel-"));
  const dataDir = path.join(tmpRoot, "data");
  const libraryRoot = path.join(tmpRoot, "library");
  await mkdir(dataDir, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  const prevEnv = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;

  t.after(async () => {
    try {
      const { _resetEvaluatorForTests } = await import("../../electron/lib/library/evaluator-queue.ts");
      _resetEvaluatorForTests();
    } catch { /* tolerate */ }
    try {
      const { closeCacheDb } = await import("../../electron/lib/library/cache-db.ts");
      closeCacheDb();
    } catch { /* tolerate */ }
    if (prevEnv.BIBLIARY_DATA_DIR === undefined) delete process.env.BIBLIARY_DATA_DIR;
    else process.env.BIBLIARY_DATA_DIR = prevEnv.BIBLIARY_DATA_DIR;
    if (prevEnv.BIBLIARY_LIBRARY_DB === undefined) delete process.env.BIBLIARY_LIBRARY_DB;
    else process.env.BIBLIARY_LIBRARY_DB = prevEnv.BIBLIARY_LIBRARY_DB;
    if (prevEnv.BIBLIARY_LIBRARY_ROOT === undefined) delete process.env.BIBLIARY_LIBRARY_ROOT;
    else process.env.BIBLIARY_LIBRARY_ROOT = prevEnv.BIBLIARY_LIBRARY_ROOT;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const { initPreferencesStore } = await import("../../electron/lib/preferences/store.ts");
  await initPreferencesStore(dataDir);

  const fixtureDir = path.join(tmpRoot, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, "cancel-book.txt");
  const body = [
    "Cancel Test Book",
    "",
    "Chapter 1: Setup",
    "",
    "Body para to ensure parser yields non-zero chapter and word count.",
    "Multiple sentences here so chunker can produce real chunks for the test.",
    "",
    "Chapter 2: Verification",
    "",
    "Second chapter for stable structure under boundary parsing.",
  ].join("\n");
  await writeFile(fixturePath, body, "utf-8");

  const { importBookFromFile } = await import("../../electron/lib/library/import-book.ts");
  const result = await importBookFromFile(fixturePath, {
    ocrEnabled: false,
    visionMetaEnabled: false,
    metadataOnlineLookup: false,
    importRoot: libraryRoot,
  });
  const bookId = result.bookId!;
  assert.ok(bookId);

  const {
    _resetEvaluatorForTests,
    _setEvaluatorDepsForTests,
    enqueueBook,
    cancelCurrentEvaluation,
    getEvaluatorStatus,
  } = await import("../../electron/lib/library/evaluator-queue.ts");
  const { getBookById } = await import("../../electron/lib/library/cache-db.ts");
  _resetEvaluatorForTests();

  /* evaluateBook ВИСИТ — ждёт abort signal. */
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: (_s, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
      }),
  });

  enqueueBook(bookId);

  /* Дать слоту стартовать. */
  const startWait = Date.now();
  while (Date.now() - startWait < 1000) {
    if (getEvaluatorStatus().currentBookId === bookId) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(getEvaluatorStatus().currentBookId, bookId, "slot picked up the book");

  cancelCurrentEvaluation("real-ipc-test-cancel");

  /* Ждём idle. */
  const cancelStart = Date.now();
  while (Date.now() - cancelStart < 3000) {
    const s = getEvaluatorStatus();
    if (!s.running && s.queueLength === 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }

  const cached = getBookById(bookId);
  assert.equal(cached?.status, "imported",
    "cancelled book MUST revert to `imported` (else user can't re-enqueue from UI)");
});
