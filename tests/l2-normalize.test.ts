/**
 * tests/l2-normalize.test.ts
 *
 * Helper l2Normalize: после mean эмбеддингов вектор должен иметь ||v||=1
 * чтобы cosine с Chroma-векторами оставался корректным.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { l2Normalize } from "../electron/lib/embedder/shared.ts";

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

test("[l2-normalize] uniformly scaled vector → ||v||=1", () => {
  const out = l2Normalize([3, 4]);
  assert.ok(Math.abs(norm(out) - 1) < 1e-12);
  assert.ok(Math.abs(out[0] - 0.6) < 1e-12);
  assert.ok(Math.abs(out[1] - 0.8) < 1e-12);
});

test("[l2-normalize] zero vector → returned as-is (no div by zero)", () => {
  const out = l2Normalize([0, 0, 0]);
  assert.deepEqual(out, [0, 0, 0]);
});

test("[l2-normalize] arithmetic mean of normalized vectors loses unit norm", () => {
  /* Демонстрируем проблему: mean двух unit-векторов даёт ||v|| < 1. */
  const a = [0.6, 0.8];
  const b = [0.8, 0.6];
  const mean = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  assert.ok(norm(mean) < 1, `mean of unit vectors should have norm <1, got ${norm(mean)}`);
  /* После l2Normalize — снова unit. */
  const renorm = l2Normalize(mean);
  assert.ok(Math.abs(norm(renorm) - 1) < 1e-12);
});

test("[l2-normalize] Float32Array input works", () => {
  const out = l2Normalize(new Float32Array([1, 0, 0]));
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out[0] - 1) < 1e-6);
});
