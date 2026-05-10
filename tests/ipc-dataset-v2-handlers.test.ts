/**
 * tests/ipc-dataset-v2-handlers.test.ts
 *
 * Unit-тесты для payload sanitization в dataset-v2.ipc.ts.
 *
 * Покрывает наиболее сложную IPC поверхность с непростым clamping
 * (pairsPerConcept 1..5, trainRatio 0..1, limit positive int) и
 * format-whitelist'ом (sharegpt | chatml). Раньше эти валидации
 * жили inline и не покрывались тестами.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateStartBatchArgs,
  sanitizeSynthesizeArgs,
  validateConceptId,
  DEFAULT_COLLECTION,
} from "../electron/ipc/handlers/dataset-v2.handlers.ts";

/* ─── validateStartBatchArgs ──────────────────────────────────────── */

test("[ipc/dataset-v2] validateStartBatchArgs: minimal valid (bookIds only)", () => {
  const r = validateStartBatchArgs({ bookIds: ["a", "b"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data?.bookIds, ["a", "b"]);
  assert.equal(r.data?.minQuality, undefined);
  assert.equal(r.data?.skipFictionOrWater, undefined);
});

test("[ipc/dataset-v2] validateStartBatchArgs: full payload", () => {
  const r = validateStartBatchArgs({
    bookIds: ["a"],
    minQuality: 75,
    skipFictionOrWater: true,
    extractModel: "qwen3-4b",
    targetCollection: "my-coll",
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.minQuality, 75);
  assert.equal(r.data?.skipFictionOrWater, true);
  assert.equal(r.data?.extractModel, "qwen3-4b");
  assert.equal(r.data?.targetCollection, "my-coll");
});

test("[ipc/dataset-v2] validateStartBatchArgs: empty/missing bookIds rejected", () => {
  for (const v of [{}, { bookIds: [] }, { bookIds: "not-array" }, null, undefined]) {
    const r = validateStartBatchArgs(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
    assert.equal(r.reason, "bookIds required");
  }
});

test("[ipc/dataset-v2] validateStartBatchArgs: filters non-string bookIds", () => {
  /* Не silent-drop'ит если ВСЕ невалидные — тогда reason. */
  const r = validateStartBatchArgs({ bookIds: [42, null, ""] });
  assert.equal(r.ok, false);
});

test("[ipc/dataset-v2] validateStartBatchArgs: partial mix preserves valid IDs", () => {
  const r = validateStartBatchArgs({ bookIds: ["a", 42, "", "b", null, "c"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data?.bookIds, ["a", "b", "c"]);
});

test("[ipc/dataset-v2] validateStartBatchArgs: invalid minQuality silently dropped", () => {
  /* Out of range или non-number → undefined, не fail. */
  for (const v of [-1, 101, NaN, Infinity, "75", null]) {
    const r = validateStartBatchArgs({ bookIds: ["a"], minQuality: v });
    assert.equal(r.ok, true);
    assert.equal(r.data?.minQuality, undefined, `${JSON.stringify(v)} silently dropped`);
  }
});

test("[ipc/dataset-v2] validateStartBatchArgs: minQuality boundary values (0, 100)", () => {
  /* Граничные значения должны приниматься. */
  const r0 = validateStartBatchArgs({ bookIds: ["a"], minQuality: 0 });
  assert.equal(r0.data?.minQuality, 0);
  const r100 = validateStartBatchArgs({ bookIds: ["a"], minQuality: 100 });
  assert.equal(r100.data?.minQuality, 100);
});

test("[ipc/dataset-v2] validateStartBatchArgs: empty string fields silently dropped", () => {
  const r = validateStartBatchArgs({
    bookIds: ["a"],
    extractModel: "   ",
    targetCollection: "",
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.extractModel, undefined);
  assert.equal(r.data?.targetCollection, undefined);
});

/* ─── sanitizeSynthesizeArgs ──────────────────────────────────────── */

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: full valid payload", () => {
  const r = sanitizeSynthesizeArgs({
    collection: "books",
    outputDir: "/tmp/dataset",
    format: "chatml",
    pairsPerConcept: 3,
    model: "qwen3-4b",
    trainRatio: 0.85,
    limit: 1000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.collection, "books");
  assert.equal(r.data?.outputDir, "/tmp/dataset");
  assert.equal(r.data?.format, "chatml");
  assert.equal(r.data?.pairsPerConcept, 3);
  assert.equal(r.data?.model, "qwen3-4b");
  assert.equal(r.data?.trainRatio, 0.85);
  assert.equal(r.data?.limit, 1000);
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: empty collection → DEFAULT_COLLECTION", () => {
  const r = sanitizeSynthesizeArgs({
    collection: "",
    outputDir: "/o",
    model: "m",
    format: "sharegpt",
    pairsPerConcept: 2,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.collection, DEFAULT_COLLECTION);
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: collection trimmed", () => {
  const r = sanitizeSynthesizeArgs({
    collection: "  books  ",
    outputDir: "/o",
    model: "m",
    format: "sharegpt",
    pairsPerConcept: 2,
  });
  assert.equal(r.data?.collection, "books");
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: unknown format → sharegpt default", () => {
  const r = sanitizeSynthesizeArgs({
    collection: "c",
    outputDir: "/o",
    model: "m",
    format: "alpaca", /* not allowed */
    pairsPerConcept: 2,
  });
  assert.equal(r.data?.format, "sharegpt");
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: pairsPerConcept clamping 1..5", () => {
  /* Сверху и снизу. */
  const rHigh = sanitizeSynthesizeArgs({
    collection: "c",
    outputDir: "/o",
    model: "m",
    format: "sharegpt",
    pairsPerConcept: 100,
  });
  assert.equal(rHigh.data?.pairsPerConcept, 5);
  /* Special case: 0 → falsy → Number(0)||2 = 2 → clamp(1..5) = 2 (current
     production semantics — see fallback chain). */
  const rZero = sanitizeSynthesizeArgs({
    collection: "c",
    outputDir: "/o",
    model: "m",
    format: "sharegpt",
    pairsPerConcept: 0,
  });
  assert.equal(rZero.data?.pairsPerConcept, 2, "0 → fallback default 2");
  const rNeg = sanitizeSynthesizeArgs({
    collection: "c",
    outputDir: "/o",
    model: "m",
    format: "sharegpt",
    pairsPerConcept: -5,
  });
  assert.equal(rNeg.data?.pairsPerConcept, 1);
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: pairsPerConcept invalid → fallback 2", () => {
  /* NaN, undefined, garbage → default 2. */
  for (const v of [NaN, undefined, null, "two", {}]) {
    const r = sanitizeSynthesizeArgs({
      collection: "c",
      outputDir: "/o",
      model: "m",
      format: "sharegpt",
      pairsPerConcept: v,
    });
    assert.equal(r.data?.pairsPerConcept, 2, `${JSON.stringify(v)} → default 2`);
  }
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: missing outputDir → error", () => {
  const r = sanitizeSynthesizeArgs({
    collection: "c",
    outputDir: "",
    model: "m",
    format: "sharegpt",
    pairsPerConcept: 2,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /папка/);
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: missing model → error", () => {
  const r = sanitizeSynthesizeArgs({
    collection: "c",
    outputDir: "/o",
    model: "",
    format: "sharegpt",
    pairsPerConcept: 2,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /модель/);
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: trainRatio out of [0..1] → default 0.9", () => {
  for (const v of [-0.1, 1.1, 5, NaN, "0.5", null]) {
    const r = sanitizeSynthesizeArgs({
      collection: "c",
      outputDir: "/o",
      model: "m",
      format: "sharegpt",
      pairsPerConcept: 2,
      trainRatio: v,
    });
    assert.equal(r.data?.trainRatio, 0.9, `${JSON.stringify(v)} → 0.9 default`);
  }
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: trainRatio boundary values (0 and 1)", () => {
  const r0 = sanitizeSynthesizeArgs({
    collection: "c", outputDir: "/o", model: "m", format: "sharegpt", pairsPerConcept: 2,
    trainRatio: 0,
  });
  assert.equal(r0.data?.trainRatio, 0);
  const r1 = sanitizeSynthesizeArgs({
    collection: "c", outputDir: "/o", model: "m", format: "sharegpt", pairsPerConcept: 2,
    trainRatio: 1,
  });
  assert.equal(r1.data?.trainRatio, 1);
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: invalid limit silently dropped", () => {
  for (const v of [-1, 0, 1.5, NaN, "100", null]) {
    const r = sanitizeSynthesizeArgs({
      collection: "c", outputDir: "/o", model: "m", format: "sharegpt", pairsPerConcept: 2,
      limit: v,
    });
    assert.equal(r.data?.limit, undefined, `${JSON.stringify(v)} dropped`);
  }
});

test("[ipc/dataset-v2] sanitizeSynthesizeArgs: non-object input → error", () => {
  for (const v of [null, undefined, "string", 42, []]) {
    const r = sanitizeSynthesizeArgs(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
  }
});

/* ─── validateConceptId ───────────────────────────────────────────── */

test("[ipc/dataset-v2] validateConceptId: valid string", () => {
  assert.equal(validateConceptId("concept-abc"), "concept-abc");
});

test("[ipc/dataset-v2] validateConceptId: empty/non-string → null", () => {
  for (const v of ["", null, undefined, 42, {}]) {
    assert.equal(validateConceptId(v), null);
  }
});
