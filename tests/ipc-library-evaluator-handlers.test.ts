/**
 * tests/ipc-library-evaluator-handlers.test.ts
 *
 * Unit-тесты для validators в library-evaluator-ipc.ts.
 *
 * Проверяет защиту IPC слоя от bad payload — самый частый источник
 * regression bug'ов: floating-point слайдер, NaN из parseInt, пустой
 * model key, не-массив bookIds и т.п. Раньше эти проверки жили inline
 * без unit-тестов.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSetSlots,
  sanitizeEvaluatorModel,
  validateReevaluateArgs,
  validatePrioritizeArgs,
  validateReparseBookArgs,
} from "../electron/ipc/handlers/library-evaluator.handlers.ts";

/* ─── validateSetSlots ────────────────────────────────────────────── */

test("[ipc/evaluator] validateSetSlots: accepts integer ≥1", () => {
  for (const n of [1, 2, 4, 8, 16, 100]) {
    const r = validateSetSlots(n);
    assert.equal(r.ok, true, `${n} should be ok`);
    assert.equal(r.slots, n);
  }
});

test("[ipc/evaluator] validateSetSlots: rejects 0 and negative", () => {
  for (const n of [0, -1, -100]) {
    const r = validateSetSlots(n);
    assert.equal(r.ok, false, `${n} should be rejected`);
  }
});

test("[ipc/evaluator] validateSetSlots: rejects non-integer numbers", () => {
  /* UI слайдер с шагом 0.5 мог бы прислать 2.5 — НЕ принимать. */
  for (const n of [1.5, 2.7, 0.1, 3.14]) {
    const r = validateSetSlots(n);
    assert.equal(r.ok, false, `${n} should be rejected (not integer)`);
  }
});

test("[ipc/evaluator] validateSetSlots: rejects NaN, Infinity, -Infinity", () => {
  for (const n of [NaN, Infinity, -Infinity]) {
    const r = validateSetSlots(n);
    assert.equal(r.ok, false, `${n} should be rejected`);
  }
});

test("[ipc/evaluator] validateSetSlots: rejects non-numbers (strings, null, etc.)", () => {
  for (const v of ["4", null, undefined, true, {}, []]) {
    const r = validateSetSlots(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected (non-number)`);
  }
});

/* ─── sanitizeEvaluatorModel ──────────────────────────────────────── */

test("[ipc/evaluator] sanitizeEvaluatorModel: passes valid string keys", () => {
  assert.equal(sanitizeEvaluatorModel("qwen3-4b"), "qwen3-4b");
  assert.equal(sanitizeEvaluatorModel("a"), "a");
});

test("[ipc/evaluator] sanitizeEvaluatorModel: empty string → null (auto-pick)", () => {
  assert.equal(sanitizeEvaluatorModel(""), null);
});

test("[ipc/evaluator] sanitizeEvaluatorModel: non-string types → null", () => {
  assert.equal(sanitizeEvaluatorModel(null), null);
  assert.equal(sanitizeEvaluatorModel(undefined), null);
  assert.equal(sanitizeEvaluatorModel(42), null);
  assert.equal(sanitizeEvaluatorModel({}), null);
  assert.equal(sanitizeEvaluatorModel([]), null);
});

/* ─── validateReevaluateArgs ──────────────────────────────────────── */

test("[ipc/evaluator] validateReevaluateArgs: valid bookId", () => {
  const r = validateReevaluateArgs({ bookId: "abc123" });
  assert.equal(r.ok, true);
  assert.equal(r.bookId, "abc123");
});

test("[ipc/evaluator] validateReevaluateArgs: missing args → reason='bookId required'", () => {
  for (const v of [null, undefined, {}, "string", 42]) {
    const r = validateReevaluateArgs(v);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "bookId required");
  }
});

test("[ipc/evaluator] validateReevaluateArgs: empty / non-string bookId → rejected", () => {
  for (const v of [{ bookId: "" }, { bookId: 123 }, { bookId: null }, { bookId: undefined }]) {
    const r = validateReevaluateArgs(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
    assert.equal(r.reason, "bookId required");
  }
});

/* ─── validatePrioritizeArgs ──────────────────────────────────────── */

test("[ipc/evaluator] validatePrioritizeArgs: valid array of strings", () => {
  const r = validatePrioritizeArgs({ bookIds: ["a", "b", "c"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bookIds, ["a", "b", "c"]);
});

test("[ipc/evaluator] validatePrioritizeArgs: filters non-strings and empty IDs", () => {
  const r = validatePrioritizeArgs({ bookIds: ["a", "", null, "b", 42, "c", undefined] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bookIds, ["a", "b", "c"], "non-string и пустые отфильтрованы");
});

test("[ipc/evaluator] validatePrioritizeArgs: preserves caller order", () => {
  /* Критично для evaluator-queue.unshift семантики. */
  const r = validatePrioritizeArgs({ bookIds: ["z", "y", "x"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bookIds, ["z", "y", "x"]);
});

test("[ipc/evaluator] validatePrioritizeArgs: empty array → ok with empty result", () => {
  const r = validatePrioritizeArgs({ bookIds: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.bookIds, []);
});

test("[ipc/evaluator] validatePrioritizeArgs: rejects non-object / missing bookIds", () => {
  for (const v of [null, undefined, {}, "string", 42, { bookIds: "not-an-array" }, { bookIds: 123 }]) {
    const r = validatePrioritizeArgs(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
  }
});

/* ─── validateReparseBookArgs ─────────────────────────────────────── */

test("[ipc/evaluator] validateReparseBookArgs: valid string", () => {
  const r = validateReparseBookArgs("book-id-xyz");
  assert.equal(r.ok, true);
  assert.equal(r.bookId, "book-id-xyz");
});

test("[ipc/evaluator] validateReparseBookArgs: empty / non-string → rejected", () => {
  for (const v of ["", null, undefined, 42, {}, []]) {
    const r = validateReparseBookArgs(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
    assert.equal(r.reason, "bookId required");
  }
});
