/**
 * tests/uniqueness-extract-ideas.test.ts
 *
 * Проверяем extractIdeasPerChapter:
 *   - LLM возвращает корректный JSON shape → ideas массив правильной формы
 *   - clamp на ideasMax (если LLM вернул больше — обрезаем)
 *   - graceful degradation: пустая глава → пустой массив, не throw
 *   - <think> блоки обрабатываются reasoning-parser
 *   - bad JSON → пустой массив (не throw)
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  extractIdeasPerChapter,
  _setUniquenessDepsForTesting,
  _resetUniquenessDepsForTesting,
} from "../electron/lib/library/uniqueness-evaluator.ts";
import type { ConvertedChapter } from "../electron/lib/library/types.ts";

function chapter(idx: number, paragraphs: string[]): ConvertedChapter {
  return {
    index: idx,
    title: `Chapter ${idx}`,
    paragraphs,
    wordCount: paragraphs.join(" ").split(/\s+/).length,
  };
}

test("[uniqueness] extractIdeasPerChapter: clean JSON → 3 ideas", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () =>
      JSON.stringify({
        ideas: [
          { title: "Hoist invariants", essence: "Move loop-invariant computations outside the loop." },
          { title: "Cache locality", essence: "Row-major iteration matches CPU cache lines." },
          { title: "Branch-free code", essence: "Avoid mispredicted branches in tight loops." },
        ],
      }),
  });
  try {
    const out = await extractIdeasPerChapter(chapter(1, ["Sample text about loops."]), "model-x", 7);
    assert.equal(out.length, 3);
    assert.equal(out[0].title, "Hoist invariants");
    assert.equal(out[0].chapterIndex, 1);
    assert.match(out[1].essence, /cache lines/);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] extractIdeasPerChapter: <think> block stripped before parse", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () =>
      "<think>Let me find the central ideas...</think>" +
      JSON.stringify({ ideas: [{ title: "X", essence: "Idea X is verifiable." }] }),
  });
  try {
    const out = await extractIdeasPerChapter(chapter(2, ["text"]), "model", 7);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "X");
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] extractIdeasPerChapter: clamps to ideasMax", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () =>
      JSON.stringify({
        ideas: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, essence: `Essence ${i}.` })),
      }),
  });
  try {
    const out = await extractIdeasPerChapter(chapter(0, ["x"]), "m", 5);
    assert.equal(out.length, 5);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] extractIdeasPerChapter: bad JSON → empty array, no throw", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () => "this is not JSON at all",
  });
  try {
    const out = await extractIdeasPerChapter(chapter(0, ["x"]), "m", 5);
    assert.deepEqual(out, []);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] extractIdeasPerChapter: empty chapter text → empty array (no LLM call)", async () => {
  let called = false;
  _setUniquenessDepsForTesting({
    callLlm: async () => {
      called = true;
      return "{}";
    },
  });
  try {
    const out = await extractIdeasPerChapter(chapter(0, []), "m", 5);
    assert.deepEqual(out, []);
    assert.equal(called, false);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] extractIdeasPerChapter: LLM throws → empty array (no rethrow)", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () => {
      throw new Error("LLM unavailable");
    },
  });
  try {
    const out = await extractIdeasPerChapter(chapter(0, ["text"]), "m", 5);
    assert.deepEqual(out, []);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] extractIdeasPerChapter: skips ideas with empty essence", async () => {
  _setUniquenessDepsForTesting({
    callLlm: async () =>
      JSON.stringify({
        ideas: [
          { title: "Good", essence: "This is a real claim." },
          { title: "Bad", essence: "" },
          { title: "Worse", essence: "   " },
          { title: "Also good", essence: "Another verifiable claim." },
        ],
      }),
  });
  try {
    const out = await extractIdeasPerChapter(chapter(0, ["x"]), "m", 5);
    assert.equal(out.length, 2);
    assert.equal(out[0].title, "Good");
    assert.equal(out[1].title, "Also good");
  } finally {
    _resetUniquenessDepsForTesting();
  }
});
