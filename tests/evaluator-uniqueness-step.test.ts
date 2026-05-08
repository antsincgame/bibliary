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
import { initPreferencesStore as initPrefs, getPreferencesStore } from "../electron/lib/preferences/store.ts";
import { _setResolverDepsForTesting, _resetResolverForTesting } from "../electron/lib/llm/model-resolver.ts";
import { setMapping, clearAll } from "../electron/lib/chroma/collection-cache.ts";
import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
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

  return {
    cleanup: async () => {
      closeCacheDb();
      _resetLibraryRootCache();
      _resetResolverForTesting();
      _resetUniquenessDepsForTesting();
      clearAll();
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
  /* Mock LLM extraction → 1 idea + embed → unit vec */
  _setUniquenessDepsForTesting({
    callLlm: async () => JSON.stringify({ ideas: [{ title: "T", essence: "Some claim." }] }),
    embed: async () => {
      const v = new Array(384).fill(0);
      v[0] = 1;
      return v;
    },
  });
  /* Mock Chroma — empty collection → all NOVEL */
  clearAll();
  setMapping("delta-knowledge", "id-1", { "hnsw:space": "cosine" });
  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/query")) {
      return new Response("no records", { status: 500 });
    }
    return jsonResponse({ id: "id-1", name: "delta-knowledge", metadata: { "hnsw:space": "cosine" } });
  });

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
    assert.equal(upsertedMeta!.uniquenessNovelCount, 1);
    assert.equal(upsertedMeta!.uniquenessTotalIdeas, 1);
    assert.ok(upsertedMeta!.uniquenessEvaluatedAt);
    assert.equal(persistCalls, 1);
  } finally {
    mock.restore();
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
  clearAll();
  setMapping("delta-knowledge", "id-1", { "hnsw:space": "cosine" });

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
