/* Phase 4 contract: parallel slots, priority, bootstrap streaming, runtime slot resize. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";

import { closeCacheDb, upsertBook, getBookById } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import {
  _resetEvaluatorForTests,
  _setEvaluatorDepsForTests,
  bootstrapEvaluatorQueue,
  enqueueBook,
  enqueuePriority,
  getEvaluatorSlotCount,
  getEvaluatorStatus,
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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-evq-slots-"));
  const dataDir = path.join(tempRoot, "data");
  const libraryRoot = path.join(dataDir, "library");
  await mkdir(libraryRoot, { recursive: true });

  const prev = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
    BIBLIARY_EVAL_SLOTS: process.env.BIBLIARY_EVAL_SLOTS,
  };

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
      for (const k of Object.keys(prev) as (keyof typeof prev)[]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function makeBook(libraryRoot: string, id: string, title: string): { meta: BookCatalogMeta; mdPath: string } {
  const bookDir = path.join(libraryRoot, id);
  const mdPath = path.join(bookDir, "book.md");
  return {
    meta: {
      id,
      sha256: id.padEnd(64, "0"),
      title,
      originalFile: "original.txt",
      originalFormat: "txt",
      wordCount: 1024,
      chapterCount: 2,
      status: "imported",
    },
    mdPath,
  };
}

async function writeBookMd(libraryRoot: string, meta: BookCatalogMeta, mdPath: string): Promise<void> {
  const dir = path.dirname(mdPath);
  await mkdir(dir, { recursive: true });
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

${"Body. ".repeat(50)}

## Chapter 2

${"More body. ".repeat(50)}
`;
  await writeFile(mdPath, md, "utf-8");
}

function fakeEvaluation(quality: number): EvaluationResult {
  return {
    evaluation: {
      title_en: "Fake",
      author_en: "Author",
      domain: "test",
      tags: ["a"],
      is_fiction_or_water: false,
      conceptual_density: 70,
      originality: 60,
      quality_score: quality,
      verdict_reason: "synth",
    },
    reasoning: null,
    raw: "{}",
    model: "fake-model",
    warnings: [],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}

async function waitForIdle(ms = 5000): Promise<void> {
  await waitFor(() => {
    const s = getEvaluatorStatus();
    return !s.running && s.queueLength === 0;
  }, ms);
}

test("evaluator: default slot count = 2 (matches plan default)", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);
  assert.equal(getEvaluatorSlotCount(), 2);
});

test("evaluator: 2 slots process 2 books TRULY in parallel (concurrent inflight)", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const a = makeBook(env.libraryRoot, "a".repeat(16), "Book A");
  const b = makeBook(env.libraryRoot, "b".repeat(16), "Book B");
  await writeBookMd(env.libraryRoot, a.meta, a.mdPath);
  await writeBookMd(env.libraryRoot, b.meta, b.mdPath);
  upsertBook(a.meta, a.mdPath);
  upsertBook(b.meta, b.mdPath);

  let inflight = 0;
  let peakInflight = 0;
  const release: Array<() => void> = [];
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async () => {
      inflight += 1;
      if (inflight > peakInflight) peakInflight = inflight;
      await new Promise<void>((res) => release.push(res));
      inflight -= 1;
      return fakeEvaluation(80);
    },
  });

  enqueueBook(a.meta.id);
  enqueueBook(b.meta.id);

  /* Дать обоим slot'ам войти в evaluateBook. */
  await waitFor(() => peakInflight >= 2, 2000);
  assert.equal(peakInflight, 2, "two slots must be inflight simultaneously");

  /* Освобождаем обоих. */
  release.forEach((fn) => fn());
  await waitForIdle();

  assert.equal(getBookById(a.meta.id)?.status, "evaluated");
  assert.equal(getBookById(b.meta.id)?.status, "evaluated");
});

test("evaluator: enqueuePriority puts a book at the head of queue", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  /* Сжимаем slots до 1, чтобы порядок был детерминирован. */
  setEvaluatorSlots(1);

  const a = makeBook(env.libraryRoot, "1".repeat(16), "First Queued");
  const b = makeBook(env.libraryRoot, "2".repeat(16), "Second Queued");
  const p = makeBook(env.libraryRoot, "9".repeat(16), "Priority Jumper");
  for (const x of [a, b, p]) {
    await writeBookMd(env.libraryRoot, x.meta, x.mdPath);
    upsertBook(x.meta, x.mdPath);
  }

  /* Блокируем первую книгу длинной evaluateBook, чтобы успеть поставить
     приоритетную раньше остальных. */
  const order: string[] = [];
  const release: Array<() => void> = [];
  let allowImmediate = false;
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async (_s, opts) => {
      const id = order.length === 0 ? a.meta.id : "next"; /* placeholder */
      void id;
      void opts;
      if (!allowImmediate) {
        await new Promise<void>((res) => release.push(res));
      }
      return fakeEvaluation(80);
    },
  });

  /* a — стартует первой и блокируется. b — встаёт за ней. */
  enqueueBook(a.meta.id);
  await waitFor(() => getEvaluatorStatus().currentBookId === a.meta.id, 2000);
  enqueueBook(b.meta.id);
  /* Теперь приоритетная — должна оказаться раньше b. */
  enqueuePriority(p.meta.id);

  /* Wrap evaluateBook так, чтобы дальше шло мгновенно и собирался порядок. */
  allowImmediate = true;
  _setEvaluatorDepsForTests({
    evaluateBook: async () => {
      const status = getEvaluatorStatus();
      if (status.currentBookId) order.push(status.currentBookId);
      return fakeEvaluation(80);
    },
  });

  /* Освобождаем первую книгу — pipeline пойдёт дальше. */
  release.forEach((fn) => fn());
  await waitForIdle();

  /* После A должен идти P (priority), потом B. Допускаем мелкое расхождение
     если slot resize прошёл — главное, чтобы P шла РАНЬШЕ B. */
  const idxP = order.indexOf(p.meta.id);
  const idxB = order.indexOf(b.meta.id);
  assert.ok(idxP >= 0, `priority book must be processed; order=${JSON.stringify(order)}`);
  assert.ok(idxB >= 0, `regular book must be processed; order=${JSON.stringify(order)}`);
  assert.ok(idxP < idxB, `priority must run before regular; got P=${idxP} B=${idxB}`);
});

test("evaluator: setEvaluatorSlots(1) shrinks pool, idle slots stop after current book", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  setEvaluatorSlots(1);
  assert.equal(getEvaluatorSlotCount(), 1);

  const book = makeBook(env.libraryRoot, "c".repeat(16), "Solo Book");
  await writeBookMd(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let parallelSeen = 0;
  let curParallel = 0;
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async () => {
      curParallel += 1;
      if (curParallel > parallelSeen) parallelSeen = curParallel;
      await new Promise((r) => setTimeout(r, 30));
      curParallel -= 1;
      return fakeEvaluation(70);
    },
  });

  enqueueBook(book.meta.id);
  await waitForIdle();
  assert.equal(parallelSeen, 1, "with slots=1, no parallel calls allowed");
});

test("evaluator: bootstrap enqueues more than BOOTSTRAP_PAGE_SIZE (no 1000-cap regression)", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  /* PAGE_SIZE=500. Создаём 600 — гарантированно две страницы. */
  const total = 600;
  for (let i = 0; i < total; i++) {
    const id = i.toString(16).padStart(16, "0");
    const book = makeBook(env.libraryRoot, id, `Book ${i}`);
    upsertBook(book.meta, book.mdPath);
  }

  /* Прежде чем стартовать bootstrap, останавливаем evaluator паузой —
     иначе slots начнут параллельно обрабатывать и портить подсчёт.
     Контракт «не обрезать на 1000» проверяется через число enqueued. */
  const queuedIds = new Set<string>();
  const unsub = subscribeEvaluator((e) => {
    if (e.type === "evaluator.queued" && e.bookId) queuedIds.add(e.bookId);
  });
  /* Подменяем deps так, чтобы evaluateBook ВИСЕЛ — тогда slots схватят
     первые 2 и будут ждать; остальные 598 спокойно сидят в очереди и мы
     можем сосчитать. */
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: () => new Promise(() => undefined), /* never resolves */
    readFile: async () =>
      `---\nid: x\nsha256: x\ntitle: x\noriginalFile: x\noriginalFormat: txt\nwordCount: 1\nchapterCount: 2\nstatus: imported\n---\n\n# x\n\n## Chapter 1\n\nbody.\n\n## Chapter 2\n\nmore.\n`,
    writeFile: async () => undefined,
  });

  await bootstrapEvaluatorQueue();
  unsub();

  /* Контракт Фазы 4.A: ВСЕ 600 книг попали в очередь, никаких обрезаний
     на 1000. evaluator.queued event эмитится для каждой при enqueueBook. */
  assert.equal(
    queuedIds.size,
    total,
    `expected ${total} queued events, got ${queuedIds.size} (regression: 1000-cap returned?)`,
  );
});

test("evaluator: status.running == true while a slot is processing, false after idle", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBook(env.libraryRoot, "5".repeat(16), "Slow Book");
  await writeBookMd(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  /* evaluateBook сигнализирует когда вошёл (entered) и ждёт сигнал (gate).
     Это даёт детерминированный момент для проверки status.running. */
  let entered: () => void = () => undefined;
  const enteredP = new Promise<void>((res) => {
    entered = res;
  });
  let release: () => void = () => undefined;
  const releaseP = new Promise<void>((res) => {
    release = res;
  });

  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async () => {
      entered();
      await releaseP;
      return fakeEvaluation(85);
    },
  });

  enqueueBook(book.meta.id);
  await enteredP; /* evaluator вошёл в LLM-вызов */
  assert.equal(getEvaluatorStatus().running, true, "running while LLM call is inflight");

  release(); /* отпускаем LLM-вызов */
  await waitForIdle();
  assert.equal(getEvaluatorStatus().running, false, "not running after queue drain");
});

test("evaluator: idle event fires only once after ALL slots drain", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  /* 4 книги с 2 slots — должно быть ровно ОДИН idle в конце. */
  const books = ["a", "b", "c", "d"].map((c) =>
    makeBook(env.libraryRoot, c.repeat(16), `Book ${c}`),
  );
  for (const x of books) {
    await writeBookMd(env.libraryRoot, x.meta, x.mdPath);
    upsertBook(x.meta, x.mdPath);
  }

  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return fakeEvaluation(80);
    },
  });

  const events: EvaluatorEvent[] = [];
  const unsub = subscribeEvaluator((e) => events.push(e));
  for (const x of books) enqueueBook(x.meta.id);
  await waitForIdle();
  unsub();

  const idleEvents = events.filter((e) => e.type === "evaluator.idle");
  assert.equal(idleEvents.length, 1, `expected exactly 1 idle event, got ${idleEvents.length}`);
});
