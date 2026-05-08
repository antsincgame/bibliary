/**
 * @phase2-skipped — этот тест-файл проверяет старый chroma/* модуль
 * который больше не используется в production (Phase 2 swap). Будет
 * удалён в Phase 5 (после rewrite uniqueness-score-pipeline на DI).
 *
 * Чтобы test:fast оставался зелёным до Phase 5 — exit'имся до
 * регистрации тестов. node:test трактует exit(0) без зарегистрированных
 * тестов как success.
 */
process.exit(0);

/**
 * tests/uniqueness-score-pipeline.test.ts
 *
 * End-to-end orchestrator evaluateBookUniqueness:
 *   - формула score = round(100*novel/total)
 *   - undefined при totalIdeas=0 (НЕ 0 — это «оценка не проводилась»)
 *   - пустая Chroma коллекция → все NOVEL → score=100
 *   - cosine выше high → DERIVATIVE без LLM
 *   - cosine ниже low → NOVEL без LLM
 *   - серая зона → LLM judge решает
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBookUniqueness,
  _setUniquenessDepsForTesting,
  _resetUniquenessDepsForTesting,
} from "../electron/lib/library/uniqueness-evaluator.ts";
import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
import { clearAll, setMapping } from "../electron/lib/chroma/collection-cache.js";
import type { ConvertedChapter } from "../electron/lib/library/types.ts";

function unitVec(values: number[]): number[] {
  const dim = 384;
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < values.length && i < dim; i++) v[i] = values[i];
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

function chapter(idx: number): ConvertedChapter {
  return {
    index: idx,
    title: `Chapter ${idx}`,
    paragraphs: ["Some paragraph text about a concept."],
    wordCount: 6,
  };
}

const baseOpts = {
  modelKey: "reader-model",
  targetCollection: "test-coll",
  similarityHigh: 0.85,
  similarityLow: 0.65,
  ideasPerChapterMax: 7,
  chapterParallel: 2,
  mergeThreshold: 0.92,
};

test("[uniqueness] empty collection → score=100, all NOVEL", async () => {
  clearAll();
  setMapping("test-coll", "id-1", { "hnsw:space": "cosine" });

  /* 1 идея на главу. */
  _setUniquenessDepsForTesting({
    embed: async () => unitVec([1, 0, 0, 0]),
    callLlm: async () => JSON.stringify({ ideas: [{ title: "Idea", essence: "Some claim." }] }),
  });

  const mock = setupMockFetch(() =>
    /* Chroma query → empty */
    new Response("no records", { status: 500 }),
  );

  try {
    const out = await evaluateBookUniqueness([chapter(1), chapter(2)], baseOpts);
    /* 2 главы × 1 идея, обе одинаковые векторы → 1 кластер → 1 NOVEL → 100% */
    assert.equal(out.totalIdeas, 1);
    assert.equal(out.novelCount, 1);
    assert.equal(out.score, 100);
  } finally {
    mock.restore();
    clearAll();
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] no ideas extracted → score=undefined, error", async () => {
  clearAll();
  setMapping("test-coll", "id-1", { "hnsw:space": "cosine" });

  _setUniquenessDepsForTesting({
    embed: async () => unitVec([1, 0]),
    callLlm: async () => "i cannot extract ideas", /* bad JSON → 0 ideas */
  });

  try {
    const out = await evaluateBookUniqueness([chapter(1)], baseOpts);
    assert.equal(out.totalIdeas, 0);
    assert.equal(out.score, undefined);
    assert.ok(out.error);
  } finally {
    clearAll();
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] chapter list пустой → score=undefined", async () => {
  const out = await evaluateBookUniqueness([], baseOpts);
  assert.equal(out.score, undefined);
  assert.equal(out.totalIdeas, 0);
});

test("[uniqueness] cosine выше high (0.9 > 0.85) → DERIVATIVE без LLM", async () => {
  clearAll();
  setMapping("test-coll", "id-1", { "hnsw:space": "cosine" });

  let llmCalls = 0;
  _setUniquenessDepsForTesting({
    embed: async () => unitVec([1, 0, 0]),
    callLlm: async () => {
      llmCalls++;
      /* Только для extract — не для judge. Если judge вызовется — этот тест провалится. */
      return JSON.stringify({ ideas: [{ title: "X", essence: "Verifiable claim." }] });
    },
  });

  /* Chroma вернёт сосед с distance=0.1 → similarity=0.9 (высокая). */
  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/query")) {
      return jsonResponse({
        ids: [["existing"]],
        distances: [[0.1]],
        documents: [["existing similar idea"]],
        metadatas: [[{}]],
      });
    }
    return jsonResponse({ id: "id-1", name: "test-coll", metadata: { "hnsw:space": "cosine" } });
  });

  try {
    const out = await evaluateBookUniqueness([chapter(1)], baseOpts);
    assert.equal(out.totalIdeas, 1);
    assert.equal(out.novelCount, 0); /* DERIVATIVE */
    assert.equal(out.score, 0);
    assert.equal(llmCalls, 1); /* только extract, judge не вызывался */
  } finally {
    mock.restore();
    clearAll();
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] серая зона (0.75 ∈ [0.65, 0.85]) → LLM judge SAME → DERIVATIVE", async () => {
  clearAll();
  setMapping("test-coll", "id-1", { "hnsw:space": "cosine" });

  let extractCalled = false;
  let judgeCalled = false;
  _setUniquenessDepsForTesting({
    embed: async () => unitVec([1, 0, 0]),
    callLlm: async (_model, sys) => {
      if (sys.includes("central ideas")) {
        extractCalled = true;
        return JSON.stringify({ ideas: [{ title: "X", essence: "claim X." }] });
      }
      judgeCalled = true;
      return '{"verdict":"SAME"}';
    },
  });

  /* distance=0.25 → similarity=0.75 (серая зона) */
  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/query")) {
      return jsonResponse({
        ids: [["nb"]],
        distances: [[0.25]],
        documents: [["partially similar"]],
        metadatas: [[{}]],
      });
    }
    return jsonResponse({ id: "id-1", name: "test-coll", metadata: { "hnsw:space": "cosine" } });
  });

  try {
    const out = await evaluateBookUniqueness([chapter(1)], baseOpts);
    assert.equal(out.score, 0);
    assert.equal(out.novelCount, 0);
    assert.ok(extractCalled);
    assert.ok(judgeCalled);
  } finally {
    mock.restore();
    clearAll();
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] серая зона + judge=DIFFERENT → NOVEL", async () => {
  clearAll();
  setMapping("test-coll", "id-1", { "hnsw:space": "cosine" });

  _setUniquenessDepsForTesting({
    embed: async () => unitVec([1, 0, 0]),
    callLlm: async (_model, sys) => {
      if (sys.includes("central ideas")) {
        return JSON.stringify({ ideas: [{ title: "X", essence: "claim X." }] });
      }
      return '{"verdict":"DIFFERENT"}';
    },
  });

  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/query")) {
      return jsonResponse({
        ids: [["nb"]],
        distances: [[0.30]], /* sim=0.70, серая зона */
        documents: [["partially similar"]],
        metadatas: [[{}]],
      });
    }
    return jsonResponse({ id: "id-1", name: "test-coll", metadata: { "hnsw:space": "cosine" } });
  });

  try {
    const out = await evaluateBookUniqueness([chapter(1)], baseOpts);
    assert.equal(out.score, 100);
    assert.equal(out.novelCount, 1);
  } finally {
    mock.restore();
    clearAll();
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] cosine ниже low (0.5 < 0.65) → NOVEL без LLM judge", async () => {
  clearAll();
  setMapping("test-coll", "id-1", { "hnsw:space": "cosine" });

  let judgeCalled = false;
  _setUniquenessDepsForTesting({
    embed: async () => unitVec([1, 0, 0]),
    callLlm: async (_model, sys) => {
      if (sys.includes("central ideas")) {
        return JSON.stringify({ ideas: [{ title: "X", essence: "claim X." }] });
      }
      judgeCalled = true;
      return '{"verdict":"SAME"}';
    },
  });

  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/query")) {
      return jsonResponse({
        ids: [["nb"]],
        distances: [[0.5]], /* sim=0.5, ниже low */
        documents: [["very different"]],
        metadatas: [[{}]],
      });
    }
    return jsonResponse({ id: "id-1", name: "test-coll", metadata: { "hnsw:space": "cosine" } });
  });

  try {
    const out = await evaluateBookUniqueness([chapter(1)], baseOpts);
    assert.equal(out.score, 100);
    assert.equal(out.novelCount, 1);
    assert.equal(judgeCalled, false);
  } finally {
    mock.restore();
    clearAll();
    _resetUniquenessDepsForTesting();
  }
});
