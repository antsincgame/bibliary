/**
 * tests/uniqueness-dedup-within-book.test.ts
 *
 * Greedy clustering идей по cosine ≥ merge threshold:
 *   - близкие векторы (sim ≥ threshold) → один кластер
 *   - далёкие → разные кластеры
 *   - центроид кластера обязательно L2-нормализован после mean
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeIdeasWithinBook,
  _setUniquenessDepsForTesting,
  _resetUniquenessDepsForTesting,
  type BookIdea,
} from "../electron/lib/library/uniqueness-evaluator.ts";

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

function idea(title: string, essence: string, chapterIndex = 0): BookIdea {
  return { title, essence, chapterIndex };
}

test("[uniqueness] dedup within book: 2 ideas одинаковые → 1 кластер", async () => {
  const sameVec = unitVec([1, 0.5, 0.2]);
  const ideasArr = [idea("a", "essence-a"), idea("b", "essence-b")];
  let i = 0;
  _setUniquenessDepsForTesting({
    embed: async () => {
      i++;
      return sameVec;
    },
  });
  try {
    const clusters = await dedupeIdeasWithinBook(ideasArr, 0.92);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].count, 2);
    assert.equal(i, 2); /* embed вызвался для каждой идеи */
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] dedup within book: разные векторы → разные кластеры", async () => {
  const vectors = [unitVec([1, 0, 0]), unitVec([0, 1, 0]), unitVec([0, 0, 1])];
  let i = 0;
  _setUniquenessDepsForTesting({
    embed: async () => vectors[i++],
  });
  try {
    const ideasArr = [idea("x", "x"), idea("y", "y"), idea("z", "z")];
    const clusters = await dedupeIdeasWithinBook(ideasArr, 0.92);
    assert.equal(clusters.length, 3);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] dedup within book: center'оид L2-нормализован после mean", async () => {
  const v1 = unitVec([1, 0.5, 0.1]);
  const v2 = unitVec([0.95, 0.55, 0.15]); /* очень близко к v1 */
  let i = 0;
  _setUniquenessDepsForTesting({
    embed: async () => (i++ === 0 ? v1 : v2),
  });
  try {
    const clusters = await dedupeIdeasWithinBook([idea("a", "a"), idea("b", "b")], 0.92);
    assert.equal(clusters.length, 1);
    let normSq = 0;
    for (const x of clusters[0].centroid) normSq += x * x;
    /* Центроид должен иметь ||v||=1 (после ренормализации). */
    assert.ok(Math.abs(Math.sqrt(normSq) - 1) < 1e-6, `||centroid|| should be 1 after L2-normalize, got ${Math.sqrt(normSq)}`);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] dedup within book: 5 идей где 2 близкие → 4 кластера", async () => {
  const v_close_1 = unitVec([1, 0, 0, 0]);
  const v_close_2 = unitVec([0.99, 0.05, 0, 0]); /* очень близко к v_close_1 */
  const v_far_1 = unitVec([0, 1, 0, 0]);
  const v_far_2 = unitVec([0, 0, 1, 0]);
  const v_far_3 = unitVec([0, 0, 0, 1]);
  const seq = [v_close_1, v_far_1, v_close_2, v_far_2, v_far_3];
  let i = 0;
  _setUniquenessDepsForTesting({
    embed: async () => seq[i++],
  });
  try {
    const ideasArr = [
      idea("c1", "c1"), idea("f1", "f1"), idea("c2", "c2"),
      idea("f2", "f2"), idea("f3", "f3"),
    ];
    const clusters = await dedupeIdeasWithinBook(ideasArr, 0.92);
    assert.equal(clusters.length, 4);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});

test("[uniqueness] dedup within book: пустой массив → []", async () => {
  const out = await dedupeIdeasWithinBook([], 0.92);
  assert.deepEqual(out, []);
});

test("[uniqueness] dedup within book: embed throws → пропуск идеи (не throw)", async () => {
  let i = 0;
  _setUniquenessDepsForTesting({
    embed: async () => {
      if (i++ === 1) throw new Error("embed failed");
      return unitVec([1, 0, 0]);
    },
  });
  try {
    const ideasArr = [idea("a", "a"), idea("b", "b"), idea("c", "c")];
    const clusters = await dedupeIdeasWithinBook(ideasArr, 0.92);
    /* 1 успешная идея + 1 пропущена + 1 успешная (та же что и первая → один кластер) */
    assert.ok(clusters.length >= 1);
  } finally {
    _resetUniquenessDepsForTesting();
  }
});
