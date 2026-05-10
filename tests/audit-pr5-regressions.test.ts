/**
 * tests/audit-pr5-regressions.test.ts
 *
 * Регрессионные тесты на 4 фикса PR #4 (commit 654b70f, 2026-05-09):
 *
 *   1. CRITICAL #1: vectorQueryNearest skip rows без `_distance`
 *      (было: `?? 0` → similarity=1.0 false-positive; стало: skip + warning).
 *      Тест: проверяем, что после успешного roundtrip _distance всегда
 *      числовой и similarity ≤ 1.0 (без false-positive perfect match).
 *
 *   2. CRITICAL #4: bootstrapEvaluatorQueue → frontmatter writeFile failure
 *      теперь mark книги как `failed` (раньше был silent catch → infinite
 *      re-bootstrap loop). Тест: подменяем writeFile через DI чтобы
 *      throw EPERM, прогоняем bootstrap, проверяем что stuck `evaluating`
 *      → `failed` с описательным lastError.
 *
 *   3. REGRESSION (5fa3766 → PR #4): DEFER_PAUSE_THRESHOLD=10 — auto-pause
 *      ровно после 10 consecutive defers, не после первого. Тест: 10 раз
 *      enqueue книгу при отсутствии модели → последняя итерация должна
 *      эмитнуть `evaluator.paused`.
 *
 *   4. v1.0.7 (autonomous heresy fix): allowAutoLoad флаг как right-to-load,
 *      consume-once. Тест: enqueue с allowAutoLoad:true → picker получает
 *      true; повторный enqueue той же книги без флага → не downgrade'ится.
 *      После взятия слотом — флаг исчерпан (повторный enqueue без → false).
 */
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
  enqueueBook,
  getEvaluatorStatus,
  subscribeEvaluator,
  type EvaluatorEvent,
} from "../electron/lib/library/evaluator-queue.ts";
import {
  initVectorDb,
  closeDb,
  setDataDirForTesting,
  ensureCollection,
  vectorUpsert,
  vectorQueryNearest,
  VECTOR_DIM,
} from "../electron/lib/vectordb/index.ts";
import type { BookCatalogMeta, EvaluationResult } from "../electron/lib/library/types.ts";

interface TestEnv {
  tempRoot: string;
  libraryRoot: string;
  cleanup: () => Promise<void>;
}

async function setupTestEnv(): Promise<TestEnv> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-pr5-"));
  const dataDir = path.join(tempRoot, "data");
  const libraryRoot = path.join(dataDir, "library");
  await mkdir(libraryRoot, { recursive: true });

  const prev = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
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

function fakeEval(quality: number): EvaluationResult {
  return {
    evaluation: {
      title_ru: "T", author_ru: "A", title_en: "T", author_en: "A",
      year: 2024, domain: "x",
      tags: ["a","b","c","d","e","f","g","h"],
      tags_ru: ["а","б","в","г","д","е","ё","ж"],
      is_fiction_or_water: false,
      conceptual_density: 70, originality: 60,
      quality_score: quality,
      verdict_reason: "synthetic verdict reason at least thirty chars",
    },
    reasoning: null, raw: "{}", model: "fake-model", warnings: [],
  };
}

async function waitForIdle(ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const s = getEvaluatorStatus();
    if (!s.running && s.queueLength === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`evaluator did not become idle within ${ms}ms`);
}

function unitVec(seed: number[]): number[] {
  const v = new Array<number>(VECTOR_DIM).fill(0);
  for (let i = 0; i < seed.length && i < VECTOR_DIM; i++) v[i] = seed[i];
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/* ─── PR #4 CRITICAL #1: vectorQueryNearest distance integrity ─────── */

test("[PR#4 #1] vectorQueryNearest: similarity range [0, 1] for known L2-normalized vectors (no false-positive 1.0 from missing _distance)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr5-vdb-"));
  setDataDirForTesting(dir);
  await initVectorDb({ dataDir: dir });
  t.after(async () => {
    await closeDb();
    setDataDirForTesting(null);
    await rm(dir, { recursive: true, force: true });
  });

  await ensureCollection({ name: "regr1" });
  /* Seed orthogonal points: identical query vector → similarity ~1.0,
     orthogonal → similarity ~0. Если _distance silently отсутствует
     и default `?? 0` возвращён — все similarity станут 1.0. */
  const v1 = unitVec([1, 0, 0, 0]);
  const v2 = unitVec([0, 1, 0, 0]);
  const v3 = unitVec([0, 0, 1, 0]);
  await vectorUpsert("regr1", [
    { id: "p1", embedding: v1, metadata: { tag: "x" }, document: "doc1" },
    { id: "p2", embedding: v2, metadata: { tag: "y" }, document: "doc2" },
    { id: "p3", embedding: v3, metadata: { tag: "z" }, document: "doc3" },
  ]);

  const neighbors = await vectorQueryNearest("regr1", v1, 3);
  /* Контракт: ровно 3 соседа, у всех есть валидное similarity. */
  assert.equal(neighbors.length, 3, "all 3 rows returned (no silent skip)");
  /* Хотя бы один — точное совпадение (p1 идентичен query). */
  const p1 = neighbors.find((n) => n.id === "p1");
  assert.ok(p1, "exact-match row p1 must be present");
  assert.ok(p1!.similarity > 0.99, `p1 similarity ~1.0, got ${p1!.similarity}`);
  /* Ортогональные — близко к 0. Если бы _distance силент пропадал и
     fallback возвращал 0 → similarity = 1.0 для всех; этот ассерт это ловит. */
  const p2 = neighbors.find((n) => n.id === "p2");
  const p3 = neighbors.find((n) => n.id === "p3");
  assert.ok(p2 && p3, "p2 + p3 present");
  assert.ok(p2!.similarity < 0.5, `p2 (orthogonal) similarity should be near 0, got ${p2!.similarity}`);
  assert.ok(p3!.similarity < 0.5, `p3 (orthogonal) similarity should be near 0, got ${p3!.similarity}`);
  /* All similarity values must be within mathematical range. */
  for (const n of neighbors) {
    assert.ok(n.similarity >= -1.0 && n.similarity <= 1.0,
      `similarity must be in [-1, 1], got ${n.similarity} for ${n.id}`);
  }
});

/* ─── PR #4 CRITICAL #4: bootstrap writeFile failure → mark as failed ─ */

test("[PR#4 #4] bootstrapEvaluatorQueue: writeFile failure on stuck book → status=failed (no infinite re-bootstrap loop)", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const stuckId = "deadbeefdeadbeef";
  const stuck = makeBook(env.libraryRoot, stuckId, "Stuck Book");
  await writeBookMd(env.libraryRoot, { ...stuck.meta, status: "evaluating" }, stuck.mdPath);
  upsertBook({ ...stuck.meta, status: "evaluating" }, stuck.mdPath);

  /* writeFile throw симулирует EPERM/EBUSY/read-only FS на frontmatter
     reset во время bootstrap. До PR #4 это был silent catch → книга
     оставалась `evaluating` в book.md → следующий bootstrap снова брал её
     в reset → бесконечный цикл. Теперь должна быть `failed` после первого
     прогона bootstrap. */
  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => "fake-model",
    evaluateBook: async () => fakeEval(80),
    /* readFile нужен для replaceFrontmatter чтения исходника. */
    readFile: async (p) => readFile(p, "utf-8"),
    writeFile: async () => {
      throw new Error("EPERM: simulated read-only fs");
    },
  });

  await bootstrapEvaluatorQueue();
  /* После bootstrap НЕ ждём idle: книга станет failed синхронно в Stage 1. */

  const cached = getBookById(stuckId);
  assert.equal(cached?.status, "failed",
    `stuck book must become failed (got ${cached?.status}) — без этого фикса infinite re-bootstrap loop`);
  assert.match(cached?.lastError ?? "", /bootstrap.*frontmatter reset failed/i,
    `lastError must describe writeFile failure for diagnostics, got: ${cached?.lastError}`);
  assert.match(cached?.lastError ?? "", /EPERM/,
    "lastError must propagate underlying EPERM message");
});

/* ─── PR #4 REGRESSION (5fa3766): DEFER_PAUSE_THRESHOLD=10 ─────────── */

test("[PR#4 5fa3766] DEFER_PAUSE_THRESHOLD: 10 consecutive no-model defers triggers evaluator.paused", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  /* 11 разных книг, на всех pickEvaluatorModel = null. После 10 defer'ов
     должен отработать pauseEvaluator(). Это контракт PR #4: pause не
     срабатывает с первого раза (избегаем permanent stall на transient
     LM Studio outage), но и не пропускает — после 10 → paused. */
  const books = Array.from({ length: 11 }, (_, i) =>
    makeBook(env.libraryRoot, `de${i.toString(16).padStart(14, "0")}`, `Defer ${i}`),
  );
  for (const b of books) {
    await writeBookMd(env.libraryRoot, b.meta, b.mdPath);
    upsertBook(b.meta, b.mdPath);
  }

  _setEvaluatorDepsForTests({
    pickEvaluatorModel: async () => null,
    evaluateBook: async () => {
      throw new Error("evaluateBook must NOT be called when pickEvaluatorModel returns null");
    },
  });

  const events: EvaluatorEvent[] = [];
  const unsub = subscribeEvaluator((e) => events.push(e));

  for (const b of books) enqueueBook(b.meta.id);
  await waitForIdle(8000);
  unsub();

  const skips = events.filter((e) => e.type === "evaluator.skipped");
  assert.ok(skips.length >= 10, `expected ≥10 skipped events, got ${skips.length}`);

  const paused = events.find((e) => e.type === "evaluator.paused");
  assert.ok(paused, "after 10 consecutive defers evaluator.paused MUST fire (DEFER_PAUSE_THRESHOLD=10 contract)");
  /* paused должен быть после ≥10 skip'ов, не раньше. */
  const pausedIdx = events.indexOf(paused!);
  const skipsBeforePause = events.slice(0, pausedIdx).filter((e) => e.type === "evaluator.skipped").length;
  assert.ok(skipsBeforePause >= 10,
    `paused fired after only ${skipsBeforePause} skips — must be at least 10 (off-by-one or threshold drifted)`);
});

/* ─── v1.0.7: allowAutoLoad флаг как right-to-load ─────────────────── */

test("[v1.0.7] enqueueBook(id, {allowAutoLoad:true}) → picker.allowAutoLoad=true (user-intent right-to-load)", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBook(env.libraryRoot, "a110aaaaaaaaaaaa", "AutoLoad Granted");
  await writeBookMd(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let receivedAutoLoad: boolean | undefined;
  _setEvaluatorDepsForTests({
    readEvaluatorPrefs: async () => ({ preferred: "preferred-x", fallbacks: [], allowFallback: true }),
    pickEvaluatorModel: async (opts) => {
      receivedAutoLoad = opts?.allowAutoLoad;
      return opts?.preferred ?? null;
    },
    evaluateBook: async () => fakeEval(80),
  });

  enqueueBook(book.meta.id, { allowAutoLoad: true });
  await waitForIdle();

  assert.equal(receivedAutoLoad, true,
    "user-intent enqueue (e.g. 'Re-evaluate' button or POST library:import) MUST grant picker right to loadModel from disk");
});

test("[v1.0.7] enqueueBook(id) without flag → picker.allowAutoLoad=false (cold-start bootstrap doesn't autoload 35GB models)", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBook(env.libraryRoot, "a220aaaaaaaaaaaa", "AutoLoad Denied");
  await writeBookMd(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let receivedAutoLoad: boolean | undefined;
  _setEvaluatorDepsForTests({
    readEvaluatorPrefs: async () => ({ preferred: "preferred-x", fallbacks: [], allowFallback: true }),
    pickEvaluatorModel: async (opts) => {
      receivedAutoLoad = opts?.allowAutoLoad;
      return opts?.preferred ?? null;
    },
    evaluateBook: async () => fakeEval(80),
  });

  /* Default enqueue — никаких флагов, имитация bootstrap-resume или фоновой
     reenqueue. До v1.0.7 это всё равно получало allowAutoLoad:true и
     bootstrap начинал грузить тяжёлые модели на старте app. */
  enqueueBook(book.meta.id);
  await waitForIdle();

  assert.equal(receivedAutoLoad, false,
    "default enqueue (no user-intent) MUST NOT grant autoload right — fixes autonomous heresy from pre-v1.0.7");
});

test("[v1.0.7] allowAutoLoad upgrade-only: re-enqueue WITHOUT flag does not downgrade an already-granted right", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBook(env.libraryRoot, "a330aaaaaaaaaaaa", "Upgrade Only");
  await writeBookMd(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  let receivedAutoLoad: boolean | undefined;
  /* evaluateBook ВИСИТ — гарантирует что enqueue выполняется ДО старта слота. */
  let release: () => void = () => {};
  _setEvaluatorDepsForTests({
    readEvaluatorPrefs: async () => ({ preferred: "preferred-x", fallbacks: [], allowFallback: true }),
    pickEvaluatorModel: async (opts) => {
      receivedAutoLoad = opts?.allowAutoLoad;
      return opts?.preferred ?? null;
    },
    evaluateBook: () => new Promise<EvaluationResult>((resolve) => {
      release = () => resolve(fakeEval(80));
    }),
  });

  /* Bootstrap-style enqueue (без флага) → ставит в очередь без права. */
  enqueueBook(book.meta.id);
  /* Сразу же user нажал "Re-evaluate" → upgrade флаг. Очередь идемпотентна:
     второй enqueue не дублирует, но контракт допускает upgrade флага. */
  enqueueBook(book.meta.id, { allowAutoLoad: true });
  /* Теперь снова bootstrap-style enqueue — НЕ должен снять флаг. */
  enqueueBook(book.meta.id);

  /* Дать слоту стартовать. */
  await new Promise((r) => setTimeout(r, 50));
  release();
  await waitForIdle();

  assert.equal(receivedAutoLoad, true,
    "once granted, allowAutoLoad must persist until slot consumes it; re-enqueue without flag must not downgrade");
});

test("[v1.0.7] allowAutoLoad consume-once: после взятия слотом следующий enqueue без флага получает false", async (t) => {
  const env = await setupTestEnv();
  t.after(env.cleanup);

  const book = makeBook(env.libraryRoot, "a440aaaaaaaaaaaa", "Consume Once");
  await writeBookMd(env.libraryRoot, book.meta, book.mdPath);
  upsertBook(book.meta, book.mdPath);

  const observedFlags: Array<boolean | undefined> = [];
  _setEvaluatorDepsForTests({
    readEvaluatorPrefs: async () => ({ preferred: "preferred-x", fallbacks: [], allowFallback: true }),
    pickEvaluatorModel: async (opts) => {
      observedFlags.push(opts?.allowAutoLoad);
      return opts?.preferred ?? null;
    },
    evaluateBook: async () => fakeEval(80),
  });

  /* 1-й проход: с флагом → picker видит true, после взятия слотом флаг
     удаляется из autoLoadAllowedBooks. */
  enqueueBook(book.meta.id, { allowAutoLoad: true });
  await waitForIdle();
  assert.equal(observedFlags[0], true, "first enqueue with flag → true");

  /* Возвращаем книгу в imported (имитируем re-enqueue после reset). */
  upsertBook(book.meta, book.mdPath);

  /* 2-й проход: без флага → picker должен получить false (флаг был
     consume-once'нут предыдущим прогоном, не остался ghost'ом). */
  enqueueBook(book.meta.id);
  await waitForIdle();
  assert.equal(observedFlags[1], false,
    "after consume, re-enqueue without flag must NOT inherit previous grant (consume-once contract)");
});
