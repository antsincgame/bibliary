/**
 * tests/uniqueness-judge-llm.test.ts
 *
 * judgeIdeaSameness:
 *   - LLM возвращает {"verdict":"SAME"} → SAME
 *   - LLM возвращает {"verdict":"DIFFERENT"} → DIFFERENT
 *   - <think> теги срезаются перед парсингом
 *   - LLM throws → DIFFERENT (не теряем кандидатов в пользу novel)
 *   - bad JSON → DIFFERENT (default позиция: keep novel)
 *   - пустые соседи → DIFFERENT без LLM call
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  judgeIdeaSameness,
  _setUniquenessDepsForTesting,
  _resetUniquenessDepsForTesting,
  type BookIdea,
} from "../electron/lib/library/uniqueness-evaluator.ts";
import type { ChromaNearestNeighbor } from "../electron/lib/chroma/points.ts";

function neighbor(doc: string, sim: number): ChromaNearestNeighbor {
  return { id: "x", document: doc, metadata: {}, similarity: sim };
}

const idea: BookIdea = {
  title: "Hoist invariants",
  essence: "Move loop-invariant computations outside the loop body.",
  chapterIndex: 1,
};

test("[uniqueness] judge: clean SAME verdict", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () => '{"verdict":"SAME"}',
  });
  try {
    const v = await judgeIdeaSameness(idea, [neighbor("invariant hoisting", 0.78)], "model");
    assert.equal(v, "SAME");
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] judge: clean DIFFERENT verdict", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () => '{"verdict":"DIFFERENT"}',
  });
  try {
    const v = await judgeIdeaSameness(idea, [neighbor("vectorization helps SIMD", 0.71)], "m");
    assert.equal(v, "DIFFERENT");
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] judge: <think> block stripped", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () => "<think>let me compare</think>{\"verdict\":\"SAME\"}",
  });
  try {
    const v = await judgeIdeaSameness(idea, [neighbor("similar idea", 0.75)], "m");
    assert.equal(v, "SAME");
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] judge: empty neighbors → DIFFERENT, no LLM call", async () => {
  let called = false;
  _setUniquenessDepsForTesting({
    callLlm: async () => {
      called = true;
      return "{}";
    },
  });
  try {
    const v = await judgeIdeaSameness(idea, [], "m");
    assert.equal(v, "DIFFERENT");
    assert.equal(called, false);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] judge: LLM throws → DIFFERENT", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () => {
      throw new Error("LLM down");
    },
  });
  try {
    const v = await judgeIdeaSameness(idea, [neighbor("anything", 0.7)], "m");
    assert.equal(v, "DIFFERENT");
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] judge: bad JSON → DIFFERENT (defensive)", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () => "i think these are the same maybe",
  });
  try {
    const v = await judgeIdeaSameness(idea, [neighbor("anything", 0.7)], "m");
    assert.equal(v, "DIFFERENT");
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] judge: case-insensitive verdict ('same') → SAME", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () => '{"verdict":"same"}',
  });
  try {
    const v = await judgeIdeaSameness(idea, [neighbor("similar", 0.75)], "m");
    assert.equal(v, "SAME");
  } finally {
    _resetUniquenessDepsForTesting();
  }
});
