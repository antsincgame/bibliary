/**
 * tests/evaluator-uniqueness-step.test.ts
 *
 * Контракт runUniquenessStep:
 *   - не throw'ает наружу — quality result уже сохранён, uniqueness graceful
 *   - skip при aborted signal (без LLM/Chroma вызовов)
 *   - skip при uniquenessEvaluationEnabled=false
 *   - skip когда reader-модель не загружена в LM Studio
 *   - на success — upsertBook + persistFrontmatter с заполненными uniqueness*
 *     полями
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { runUniquenessStep } from "../electron/lib/library/evaluator-uniqueness-step.ts";
import {
  _setUniquenessDepsForTesting,
  _resetUniquenessDepsForTesting,
} from "../electron/lib/library/uniqueness-evaluator.ts";
import { closeCacheDb } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import { initPreferencesStore as initPrefs, getPreferencesStore } from "../server/lib/scanner/_vendor/preferences/store.ts";
import { _setResolverDepsForTesting, _resetResolverForTesting } from "../server/lib/scanner/_vendor/llm/model-resolver.ts";
import {
  initVectorDb,
  closeDb,
  setDataDirForTesting,
  ensureCollection,
} from "../electron/lib/vectordb/index.ts";
import type { BookCatalogMeta, ConvertedChapter } from "../electron/lib/library/types.ts";

interface Sandbox {
  cleanup: () => Promise<void>;
}

async function makeSandbox(uniquenessEnabled: boolean): Promise<Sandbox> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-eval-uniq-"));
  const dataDir = path.join(tempRoot, "data");
  const prev = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = path.join(dataDir, "library");
  closeCacheDb();
  _resetLibraryRootCache();
  initPrefs(dataDir);
  await getPreferencesStore().ensureDefaults();
  await getPreferencesStore().set({ uniquenessEvaluationEnabled: uniquenessEnabled });
  /* Real in-process LanceDB на mkdtemp dataDir — заменяет chroma HTTP mock. */
  setDataDirForTesting(dataDir);
  await initVectorDb({ dataDir });

  return {
    cleanup: async () => {
      closeCacheDb();
      _resetLibraryRootCache();
      _resetResolverForTesting();
      _resetUniquenessDepsForTesting();
      await closeDb();
      setDataDirForTesting(null);
      for (const k of Object.keys(prev) as (keyof typeof prev)[]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const baseMeta: BookCatalogMeta = {
  id: "book-1",
  sha256: "a".repeat(64),
  originalFile: "x.pdf",
  originalFormat: "pdf",
  title: "Test",
  wordCount: 100,
  chapterCount: 1,
  status: "evaluated",
};

const chapters: ConvertedChapter[] = [{
  index: 0, title: "Ch1", paragraphs: ["Some content."], wordCount: 2,
}];

test("[uniqueness-step] aborted signal → skip без LLM/upsert вызовов", async () => {
  const sb = await makeSandbox(true);
  let upserted = 0, persisted = 0;
  const ctrl = new AbortController();
  ctrl.abort("test");
  try {
    await runUniquenessStep({
      baseMeta, chapters, mdPath: "/tmp/x.md", md: "---\n---", reasoning: null,
      signal: ctrl.signal,
      persistFrontmatter: async () => { persisted++; },
      upsertBook: () => { upserted++; },
    });
    assert.equal(upserted, 0);
    assert.equal(persisted, 0);
  } finally {
    await sb.cleanup();
  }
});

test("[uniqueness-step] uniquenessEvaluationEnabled=false → skip без вызовов", async () => {
  const sb = await makeSandbox(false);
  let upserted = 0, persisted = 0;
  const ctrl = new AbortController();
  try {
    await runUniquenessStep({
      baseMeta, chapters, mdPath: "/tmp/x.md", md: "---\n---", reasoning: null,
      signal: ctrl.signal,
      persistFrontmatter: async () => { persisted++; },
      upsertBook: () => { upserted++; },
    });
    assert.equal(upserted, 0);
    assert.equal(persisted, 0);
  } finally {
    await sb.cleanup();
  }
});

test("[uniqueness-step] нет загруженной reader-модели → skip без upsert", async () => {
  const sb = await makeSandbox(true);
  _setResolverDepsForTesting({
    listLoaded: async () => [], /* пусто = нет моделей */
    getPrefs: async () => ({}),
  });
  let upserted = 0;
  const ctrl = new AbortController();
  try {
    await runUniquenessStep({
      baseMeta, chapters, mdPath: "/tmp/x.md", md: "---\n---", reasoning: null,
      signal: ctrl.signal,
      persistFrontmatter: async () => {},
      upsertBook: () => { upserted++; },
    });
    assert.equal(upserted, 0);
  } finally {
    await sb.cleanup();
  }
});

test("[uniqueness-step] success → upsertBook + persistFrontmatter с uniqueness полями", async () => {
  const sb = await makeSandbox(true);
  /* Reader model loaded */
  _setResolverDepsForTesting({
    listLoaded: async () => [{ identifier: "reader-x", modelKey: "reader-x" }],
    getPrefs: async () => ({ readerModel: "reader-x" }),
  });
  /* Mock LLM: возвращаем 3 distinct ideas (≥ MIN_CLUSTERS_FOR_SCORE=3),
   * чтобы пройти smoothing-gate и получить численный score. */
  let embedCall = 0;
  _setUniquenessDepsForTesting({
    callLlm: async () => JSON.stringify({ ideas: [
      { title: "T1", essence: "First distinct claim." },
      { title: "T2", essence: "Second distinct claim." },
      { title: "T3", essence: "Third distinct claim." },
    ] }),
    /* Каждый idea получает orthogonal unit vector, чтобы они не схлопывались
     * в один кластер при mergeThreshold=0.92. */
    embed: async () => {
      const v = new Array(384).fill(0);
      v[embedCall++ % 384] = 1;
      return v;
    },
  });
  /* Empty LanceDB collection → vectorQueryNearest вернёт 0 neighbors →
   * все 3 кластера трактуются как NOVEL → score=100. */
  await ensureCollection({ name: "delta-knowledge", distance: "cosine" });

  let upsertedMeta: BookCatalogMeta | null = null;
  let persistCalls = 0;
  const ctrl = new AbortController();
  try {
    await runUniquenessStep({
      baseMeta, chapters, mdPath: "/tmp/x.md", md: "---\n---", reasoning: "thought",
      signal: ctrl.signal,
      persistFrontmatter: async () => { persistCalls++; },
      upsertBook: (m) => { upsertedMeta = m; },
    });
    assert.ok(upsertedMeta, "upsertBook должен быть вызван");
    assert.equal(upsertedMeta!.uniquenessScore, 100);
    assert.equal(upsertedMeta!.uniquenessNovelCount, 3);
    assert.equal(upsertedMeta!.uniquenessTotalIdeas, 3);
    assert.ok(upsertedMeta!.uniquenessEvaluatedAt);
    assert.equal(persistCalls, 1);
  } finally {
    await sb.cleanup();
  }
});

test("[uniqueness-step] insufficient clusters (total<3) → score undefined + error", async () => {
  const sb = await makeSandbox(true);
  _setResolverDepsForTesting({
    listLoaded: async () => [{ identifier: "reader-x", modelKey: "reader-x" }],
    getPrefs: async () => ({ readerModel: "reader-x" }),
  });
  /* 2 distinct ideas → < MIN_CLUSTERS_FOR_SCORE=3 → smoothing kicks in. */
  let embedCall = 0;
  _setUniquenessDepsForTesting({
    callLlm: async () => JSON.stringify({ ideas: [
      { title: "T1", essence: "First claim." },
      { title: "T2", essence: "Second claim." },
    ] }),
    embed: async () => {
      const v = new Array(384).fill(0);
      v[embedCall++ % 384] = 1;
      return v;
    },
  });
  await ensureCollection({ name: "delta-knowledge", distance: "cosine" });

  let upsertedMeta: BookCatalogMeta | null = null;
  const ctrl = new AbortController();
  try {
    await runUniquenessStep({
      baseMeta, chapters, mdPath: "/tmp/x.md", md: "---\n---", reasoning: null,
      signal: ctrl.signal,
      persistFrontmatter: async () => {},
      upsertBook: (m) => { upsertedMeta = m; },
    });
    assert.ok(upsertedMeta);
    assert.equal(upsertedMeta!.uniquenessScore, undefined);
    assert.equal(upsertedMeta!.uniquenessTotalIdeas, 2);
    assert.match(upsertedMeta!.uniquenessError ?? "", /insufficient clusters/);
  } finally {
    await sb.cleanup();
  }
});

test("[uniqueness-step] LLM throws → swallow, не throw наружу", async () => {
  const sb = await makeSandbox(true);
  _setResolverDepsForTesting({
    listLoaded: async () => [{ identifier: "reader-x", modelKey: "reader-x" }],
    getPrefs: async () => ({ readerModel: "reader-x" }),
  });
  _setUniquenessDepsForTesting({
    callLlm: async () => { throw new Error("LLM crashed"); },
    embed: async () => new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
  });
  await ensureCollection({ name: "delta-knowledge", distance: "cosine" });

  const ctrl = new AbortController();
  try {
    /* Не throw — функция глотает ошибки extract'а; uniqueness просто не получит идей. */
    await runUniquenessStep({
      baseMeta, chapters, mdPath: "/tmp/x.md", md: "---\n---", reasoning: null,
      signal: ctrl.signal,
      persistFrontmatter: async () => {},
      upsertBook: () => {},
    });
    /* Если дошли сюда — runUniquenessStep не throw'нул. Ок. */
  } finally {
    await sb.cleanup();
  }
});
