/* Cover the evaluator queue worker: enqueue, single-flight, abort, error recovery, bootstrap. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";

import { closeCacheDb, upsertBook, getBookById } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import {
  _resetEvaluatorForTests,
  _setEvaluatorDepsForTests,
  bootstrapEvaluatorQueue,
  cancelCurrentEvaluation,
  enqueueBook,
  getEvaluatorStatus,
  pauseEvaluator,
  resumeEvaluator,
  setEvaluatorModel,
  setEvaluatorSlots,
  subscribeEvaluator,
  type EvaluatorEvent,
} from "../electron/lib/library/evaluator-queue.ts";
import type { BookCatalogMeta, EvaluationResult } from "../electron/lib/library/types.ts";

interface TestEnv {
  tempRoot: string;
  libraryRoot: string;
  cleanup: () => Promise<void>;
}

async function setupTestEnv(): Promise<TestEnv> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-evq-"));
  const dataDir = path.join(tempRoot, "data");
  const libraryRoot = path.join(dataDir, "library");
  await mkdir(libraryRoot, { recursive: true });

  const prevDataDir = process.env.BIBLIARY_DATA_DIR;
  const prevLibraryDb = process.env.BIBLIARY_LIBRARY_DB;
  const prevLibraryRoot = process.env.BIBLIARY_LIBRARY_ROOT;

  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;

  closeCacheDb();
  _resetLibraryRootCache();
  _resetEvaluatorForTests();

  return {
    tempRoot,
    libraryRoot,
    cleanup: async () => {
      _resetEvaluatorForTests();
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

function makeBookFile(libraryRoot: string, id: string, title: string): { meta: BookCatalogMeta; mdPath: string } {
  const bookDir = path.join(libraryRoot, id);
  const mdPath = path.join(bookDir, "book.md");
  const meta: BookCatalogMeta = {
    id,
    sha256: id.padEnd(64, "0"),
    title,
    originalFile: "original.txt",
    originalFormat: "txt",
    wordCount: 1024,
    chapterCount: 2,
    status: "imported",
  };
  return { meta, mdPath };
}

async function writeBookMarkdown(libraryRoot: string, meta: BookCatalogMeta, mdPath: string): Promise<void> {
  const bookDir = path.dirname(mdPath);
  await mkdir(bookDir, { recursive: true });
  const md = `---
id: ${meta.id}
sha256: ${meta.sha256}
title: ${meta.title}
originalFile: ${meta.originalFile}
originalFormat: ${meta.originalFormat}
wordCount: ${meta.wordCount}
chapterCount: ${meta.chapterCount}
status: ${meta.status}
---

# ${meta.title}

## Chapter 1

${"Lorem ipsum body text. ".repeat(50)}

## Chapter 2

${"Dolor sit amet body text. ".repeat(50)}
`;
  await writeFile(mdPath, md, "utf-8");
}

function makeFakeEvaluation(qualityScore: number, isFiction = false): EvaluationResult {
  return {
    evaluation: {
      title_ru: "Фальшивое название",
      author_ru: "Тестовый автор",
      title_en: "Fake Title",
      author_en: "Test Author",
      year: 2024,
      domain: "test domain",
      tags: ["a", "b", "c", "d", "e", "f", "g", "h"],
      tags_ru: ["а", "б", "в", "г", "д", "е", "ё", "ж"],
      is_fiction_or_water: isFiction,
      conceptual_density: 70,
      originality: 60,
      quality_score: qualityScore,
      verdict_reason: "synthetic verdict",
    },
    reasoning: "synthetic chain of thought",
    raw: "{}",
    model: "fake-model",
    warnings: [],
  };
}

function collectEvents(): { events: EvaluatorEvent[]; unsubscribe: () => void } {
  const events: EvaluatorEvent[] = [];
  const unsubscribe = subscribeEvaluator((e) => events.push(e));
  return { events, unsubscribe };
}

async function waitForIdle(ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const status = getEvaluatorStatus();
    if (!status.running && status.queueLength === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`evaluator did not become idle within ${ms}ms`);
}

test("evaluator-queue happy path: two books processed sequentially", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const a = makeBookFile(env.libraryRoot, "aaaaaaaaaaaaaaaa", "Book A");
  const b = makeBookFile(env.libraryRoot, "bbbbbbbbbbbbbbbb", "Book B");
  await writeBookMarkdown(env.libraryRoot, a.meta, a.mdPath);
  await writeBookMarkdown(env.libraryRoot, b.meta, b.mdPath);
  upsertBook(a.meta, a.mdPath);
  upsertBook(b.meta, b.mdPath);

  const calls: string[] = [];
  _setEvaluatorDepsForTests({
    evaluateBook: async (_surrogate, opts) => {
      calls.push(opts.model);
      return makeFakeEvaluation(80);
    },
    pickEvaluatorModel: async () => "fake-model",
  });

  const { events } = collectEvents();
  enqueueBook(a.meta.id);
  enqueueBook(b.meta.id);

  await waitForIdle();

  assert.equal(calls.length, 2, "evaluateBook called once per book");
  const cachedA = getBookById(a.meta.id);
  const cachedB = getBookById(b.meta.id);
  assert.ok(cachedA && cachedB, "both rows present");
  assert.equal(cachedA?.status, "evaluated");
  assert.equal(cachedB?.status, "evaluated");
  assert.equal(cachedA?.qualityScore, 80);
  assert.equal(cachedB?.qualityScore, 80);
  assert.equal(cachedA?.evaluatorModel, "fake-model");

  const status = getEvaluatorStatus();
  assert.equal(status.totalEvaluated, 2);
  assert.equal(status.totalFailed, 0);
  assert.equal(status.queueLength, 0);

  const types = events.map((e) => e.type);
  assert.ok(types.includes("evaluator.queued"));
  assert.ok(types.includes("evaluator.started"));
  assert.ok(types.includes("evaluator.done"));
  assert.ok(types.includes("evaluator.idle"));

  const updatedMd = await readFile(a.mdPath, "utf-8");
  assert.match(updatedMd, /status: evaluated/);
  assert.match(updatedMd, /qualityScore: 80/);
  assert.match(updatedMd, /titleRu:/);
  assert.match(updatedMd, /Evaluator Reasoning/);
  assert.match(updatedMd, /synthetic chain of thought/);
});

test("evaluator-queue is idempotent: enqueue same id twice runs once", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "cccccccccccccccc", "Book C");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let runs = 0;
  _setEvaluatorDepsForTests({
    evaluateBook: async () => {
      runs += 1;
      return makeFakeEvaluation(75);
    },
    pickEvaluatorModel: async () => "fake-model",
  });

  enqueueBook(book.meta.id);
  enqueueBook(book.meta.id);
  enqueueBook(book.meta.id);
  await waitForIdle();
  assert.equal(runs, 1, "duplicate enqueues collapsed into one run");
});

test("evaluator-queue skips books that are no longer 'imported'", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "dddddddddddddddd", "Book D");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  /* Книга уже evaluated к моменту обработки -- evaluator должен пропустить. */
  const evaluated: BookCatalogMeta = { ...book.meta, status: "evaluated", qualityScore: 90 };
  upsertBook(evaluated, book.mdPath);

  let llmCalled = false;
  _setEvaluatorDepsForTests({
    evaluateBook: async () => {
      llmCalled = true;
      return makeFakeEvaluation(50);
    },
  });

  const { events } = collectEvents();
  enqueueBook(book.meta.id);
  await waitForIdle();

  assert.equal(llmCalled, false, "no LLM call for already-evaluated book");
  assert.ok(events.some((e) => e.type === "evaluator.skipped"));
  const cached = getBookById(book.meta.id);
  assert.equal(cached?.status, "evaluated", "row not regressed");
  assert.equal(cached?.qualityScore, 90);
});

test("evaluator-queue marks book as 'failed' when there are no chapters", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const id = "eeeeeeeeeeeeeeee";
  const bookDir = path.join(env.libraryRoot, id);
  const mdPath = path.join(bookDir, "book.md");
  await mkdir(bookDir, { recursive: true });
  /* Frontmatter без секций глав -- parseBookMarkdownChapters вернёт []. */
  await writeFile(mdPath, `---\nid: ${id}\nsha256: ${id.padEnd(64, "0")}\ntitle: Empty Book\noriginalFile: original.txt\noriginalFormat: txt\nwordCount: 0\nchapterCount: 0\nstatus: imported\n---\n\nbody but no chapters.\n`, "utf-8");

  const meta: BookCatalogMeta = {
    id,
    sha256: id.padEnd(64, "0"),
    title: "Empty Book",
    originalFile: "original.txt",
    originalFormat: "txt",
    wordCount: 0,
    chapterCount: 0,
    status: "imported",
  };
  upsertBook(meta, mdPath);

  let llmCalled = false;
  _setEvaluatorDepsForTests({
    evaluateBook: async () => {
      llmCalled = true;
      return makeFakeEvaluation(50);
    },
    pickEvaluatorModel: async () => "fake-model",
  });

  const { events } = collectEvents();
  enqueueBook(meta.id);
  await waitForIdle();

  assert.equal(llmCalled, false, "evaluator must not call LLM for chapter-less books");
  const failed = events.find((e) => e.type === "evaluator.failed");
  assert.ok(failed, "expected evaluator.failed event");
  assert.equal(failed?.error, "no chapters");
  const cached = getBookById(meta.id);
  assert.equal(cached?.status, "failed");
  assert.equal(getEvaluatorStatus().totalFailed, 1);
});

test("evaluator-queue handles 'no LLM loaded' gracefully", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "ffffffffffffffff", "Book F");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let llmCalled = false;
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => null,
    evaluateBook: async () => {
      llmCalled = true;
      return makeFakeEvaluation(50);
    },
  });

  const { events } = collectEvents();
  enqueueBook(book.meta.id);
  await waitForIdle();

  assert.equal(llmCalled, false, "no LLM call when no model available");
  const failed = events.find((e) => e.type === "evaluator.failed");
  /* После 2026-04 фикса error приходит с префиксом `evaluator:` для
     консистентности с warning-ами в md-frontmatter. */
  assert.equal(failed?.error, "evaluator: no LLM loaded in LM Studio");
  const cached = getBookById(book.meta.id);
  assert.equal(cached?.status, "failed");
});

test("evaluator-queue handles throw from pickEvaluatorModel without crashing the queue", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "eeeeeeeeeeeeeeee", "Book pickModel throw");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let llmCalled = false;
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => {
      throw new Error("simulated pickEvaluatorModel crash");
    },
    evaluateBook: async () => {
      llmCalled = true;
      return makeFakeEvaluation(50);
    },
  });

  const { events } = collectEvents();
  enqueueBook(book.meta.id);
  await waitForIdle();

  assert.equal(llmCalled, false, "evaluateBook must not run when pickEvaluatorModel throws");
  const failed = events.find((e) => e.type === "evaluator.failed");
  assert.equal(failed?.error, "simulated pickEvaluatorModel crash");
  const cached = getBookById(book.meta.id);
  assert.equal(cached?.status, "failed");
  assert.equal(getEvaluatorStatus().totalFailed, 1);
});

test("evaluator-queue continues after a single book fails (multi-book error recovery)", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  /* Single slot so first enqueued book is always evaluated first (count===1 throws for A). */
  setEvaluatorSlots(1);

  const a = makeBookFile(env.libraryRoot, "1111111111111111", "Book 1 (fails)");
  const b = makeBookFile(env.libraryRoot, "2222222222222222", "Book 2 (ok)");
  await writeBookMarkdown(env.libraryRoot, a.meta, a.mdPath);
  await writeBookMarkdown(env.libraryRoot, b.meta, b.mdPath);
  upsertBook(a.meta, a.mdPath);
  upsertBook(b.meta, b.mdPath);

  let count = 0;
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async () => {
      count += 1;
      if (count === 1) throw new Error("simulated LLM crash");
      return makeFakeEvaluation(85);
    },
  });

  const { events } = collectEvents();
  enqueueBook(a.meta.id);
  enqueueBook(b.meta.id);
  await waitForIdle();

  assert.equal(count, 2, "both books attempted");
  const cachedA = getBookById(a.meta.id);
  const cachedB = getBookById(b.meta.id);
  assert.equal(cachedA?.status, "failed");
  assert.equal(cachedB?.status, "evaluated");
  assert.equal(cachedB?.qualityScore, 85);

  const failed = events.find((e) => e.type === "evaluator.failed" && e.bookId === a.meta.id);
  const done = events.find((e) => e.type === "evaluator.done" && e.bookId === b.meta.id);
  assert.ok(failed, "failed event for first book");
  assert.ok(done, "done event for second book");
});

test("evaluator-queue handles abort signal via cancelCurrentEvaluation", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "3333333333333333", "Book Cancel");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: (_surrogate, opts) =>
      new Promise<EvaluationResult>((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          reject(new Error("aborted by signal"));
        });
      }),
  });

  const { events } = collectEvents();
  enqueueBook(book.meta.id);
  /* Дать воркеру стартовать. */
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getEvaluatorStatus().currentBookId, book.meta.id);

  cancelCurrentEvaluation("test-cancel");
  await waitForIdle();

  const skipped = events.find((e) => e.type === "evaluator.skipped");
  assert.ok(skipped, "skipped event after cancel");
  assert.equal(skipped?.error, "aborted");
  const cached = getBookById(book.meta.id);
  assert.equal(cached?.status, "imported", "cancelled book regressed to imported");
});

test("evaluator-queue pause/resume defers processing", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "4444444444444444", "Book Pause");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let evaluated = 0;
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async () => {
      evaluated += 1;
      return makeFakeEvaluation(72);
    },
  });

  const { events } = collectEvents();
  pauseEvaluator();
  enqueueBook(book.meta.id);
  /* Дать paused worker'у проверить очередь и выйти. */
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(evaluated, 0, "no work while paused");
  assert.ok(events.some((e) => e.type === "evaluator.paused"));

  resumeEvaluator();
  await waitForIdle();
  assert.equal(evaluated, 1, "work resumed exactly once");
  assert.ok(events.some((e) => e.type === "evaluator.resumed"));
  const cached = getBookById(book.meta.id);
  assert.equal(cached?.status, "evaluated");
});

test("evaluator-queue bootstrap resets stuck 'evaluating' rows back to 'imported'", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const stuckId = "5555555555555555";
  const stuck = makeBookFile(env.libraryRoot, stuckId, "Stuck Book");
  await writeBookMarkdown(env.libraryRoot, { ...stuck.meta, status: "evaluating" }, stuck.mdPath);
  upsertBook({ ...stuck.meta, status: "evaluating" }, stuck.mdPath);

  let calls = 0;
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async () => {
      calls += 1;
      return makeFakeEvaluation(95);
    },
  });

  await bootstrapEvaluatorQueue();
  await waitForIdle();

  assert.equal(calls, 1, "stuck row picked up on bootstrap");
  const cached = getBookById(stuckId);
  assert.equal(cached?.status, "evaluated");
  assert.equal(cached?.qualityScore, 95);

  const md = await readFile(stuck.mdPath, "utf-8");
  assert.doesNotMatch(md, /status: evaluating/, "frontmatter no longer says evaluating");
});

test("evaluator-queue passes prefs.evaluatorModel into pickEvaluatorModel (no silent substitution)", async (t) => {
  /* Регрессия 2026-04: до фикса очередь игнорировала Settings → Models →
     Evaluator и шла в pickEvaluatorModel БЕЗ хинтов, который выбирал
     «самую мощную» через скоринг + автоматически догружал её через
     loadModel(gpuOffload=max). Это приводило к выбору модели, которой
     нет в списке Settings, и к freeze ОС из-за двух больших LLM в VRAM. */
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "7777777777777777", "Book Prefs");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let receivedOpts: { preferred?: string; fallbacks?: string[]; allowAutoLoad?: boolean } | null = null;
  let usedModel = "";
  _setEvaluatorDepsForTests({
    readEvaluatorPrefs: async () => ({
      preferred: "user-selected-model",
      fallbacks: ["fallback-a", "fallback-b"],
    }),
    pickEvaluatorModel: async (opts) => {
      receivedOpts = opts ?? null;
      return opts?.preferred ?? null;
    },
    evaluateBook: async (_s, o) => {
      usedModel = o.model;
      return makeFakeEvaluation(70);
    },
  });

  enqueueBook(book.meta.id);
  await waitForIdle();

  assert.ok(receivedOpts, "pickEvaluatorModel received options");
  assert.equal(receivedOpts!.preferred, "user-selected-model");
  assert.deepEqual(receivedOpts!.fallbacks, ["fallback-a", "fallback-b"]);
  assert.equal(receivedOpts!.allowAutoLoad, false, "picker НЕ должен иметь права на скрытую догрузку другой модели");
  assert.equal(usedModel, "user-selected-model", "evaluateBook получил выбранную в Settings модель");
});

test("evaluator-queue marks book failed with descriptive reason when preferred model not loaded", async (t) => {
  /* Cache-db не персистит warnings (только md-frontmatter), поэтому reason
     проверяем через event evaluator.failed.error и через содержимое
     book.md, в который evaluator-queue записывает frontmatter. */
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "8888888888888888", "Book Prefs Missing");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  _setEvaluatorDepsForTests({
    readEvaluatorPrefs: async () => ({ preferred: "ghost-model", fallbacks: [] }),
    pickEvaluatorModel: async () => null,
    evaluateBook: async () => {
      throw new Error("evaluateBook must NOT be called when no model selected");
    },
  });

  const { events } = collectEvents();
  enqueueBook(book.meta.id);
  await waitForIdle();

  const cached = getBookById(book.meta.id);
  assert.equal(cached?.status, "failed");

  const failed = events.find((e) => e.type === "evaluator.failed");
  assert.ok(failed, "evaluator.failed event present");
  assert.match(failed!.error ?? "", /ghost-model/, "error упоминает выбранную пользователем модель");
  assert.match(failed!.error ?? "", /not loaded/i);

  /* Frontmatter book.md тоже должен содержать warning с моделью. */
  const md = await readFile(book.mdPath, "utf-8");
  assert.match(md, /ghost-model/);
});

test("setEvaluatorModel overrides pickEvaluatorModel result", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBookFile(env.libraryRoot, "6666666666666666", "Book Override");
  await writeBookMarkdown(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let pickCalled = false;
  let usedModel = "";
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => {
      pickCalled = true;
      return "auto-picked-model";
    },
    evaluateBook: async (_surrogate, opts) => {
      usedModel = opts.model;
      return makeFakeEvaluation(70);
    },
  });

  setEvaluatorModel("user-chosen-model");
  enqueueBook(book.meta.id);
  await waitForIdle();

  assert.equal(pickCalled, false, "pickEvaluatorModel skipped when override active");
  assert.equal(usedModel, "user-chosen-model");
  setEvaluatorModel(null);
});
