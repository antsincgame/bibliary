/**
 * tests/token-overflow-guard.test.ts
 *
 * Unit-тесты для electron/lib/token/overflow-guard.ts:
 * регистры modelContext + ContextOverflowError shape.
 *
 * Это критичный модуль — вся LLM pipeline зависит от правильного
 * размера ctx, который регистрируется здесь после load model.
 * Сломанный registry = pipeline без truncate → LM Studio HTTP 400.
 *
 * Тесты не трогают TokenBudgetManager (он тестируется отдельно),
 * фокус только на registry API и ошибке.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerModelContext,
  unregisterModelContext,
  getModelContext,
  resetOverflowGuard,
  ContextOverflowError,
} from "../electron/lib/token/overflow-guard.ts";

/* ─── registerModelContext / getModelContext ────────────────────── */

test("[overflow-guard] registerModelContext + getModelContext: roundtrip", () => {
  resetOverflowGuard();
  registerModelContext("qwen3-4b", 8192);
  assert.equal(getModelContext("qwen3-4b"), 8192);
});

test("[overflow-guard] getModelContext: не зарегистрированная модель → null", () => {
  resetOverflowGuard();
  assert.equal(getModelContext("unknown-model"), null);
});

test("[overflow-guard] registerModelContext: повторный обновляет (релоад модели)", () => {
  /* Сценарий: пользователь unload+load модель с другим contextLength.
     Регистр должен показывать АКТУАЛЬНЫЙ ctx, не прежний. */
  resetOverflowGuard();
  registerModelContext("model-x", 4096);
  registerModelContext("model-x", 16384);
  assert.equal(getModelContext("model-x"), 16384);
});

test("[overflow-guard] unregisterModelContext: убирает из регистра", () => {
  resetOverflowGuard();
  registerModelContext("model-y", 8192);
  assert.equal(getModelContext("model-y"), 8192);
  unregisterModelContext("model-y");
  assert.equal(getModelContext("model-y"), null);
});

test("[overflow-guard] unregisterModelContext: несуществующая модель — no-op", () => {
  resetOverflowGuard();
  /* Не тробросить. */
  assert.doesNotThrow(() => unregisterModelContext("never-registered"));
});

test("[overflow-guard] resetOverflowGuard: всё сброшено", () => {
  registerModelContext("a", 1024);
  registerModelContext("b", 2048);
  registerModelContext("c", 4096);
  resetOverflowGuard();
  assert.equal(getModelContext("a"), null);
  assert.equal(getModelContext("b"), null);
  assert.equal(getModelContext("c"), null);
});

test("[overflow-guard] независимые modelKey не пересекаются", () => {
  resetOverflowGuard();
  registerModelContext("qwen3-4b", 8192);
  registerModelContext("llama-7b", 4096);
  assert.equal(getModelContext("qwen3-4b"), 8192);
  assert.equal(getModelContext("llama-7b"), 4096);
  unregisterModelContext("qwen3-4b");
  /* qwen3-4b убран, llama-7b остался. */
  assert.equal(getModelContext("qwen3-4b"), null);
  assert.equal(getModelContext("llama-7b"), 4096);
});

/* ─── ContextOverflowError shape ───────────────────────────── */

test("[overflow-guard] ContextOverflowError: все поля доступны", () => {
  const err = new ContextOverflowError("qwen3-4b", 10000, 8000);
  assert.equal(err.modelKey, "qwen3-4b");
  assert.equal(err.required, 10000);
  assert.equal(err.available, 8000);
  assert.equal(err.name, "ContextOverflowError");
  assert.match(err.message, /qwen3-4b/);
  assert.match(err.message, /10000/);
  assert.match(err.message, /8000/);
});

test("[overflow-guard] ContextOverflowError: instanceof Error", () => {
  /* Критично — caller catch'ит эту ошибку вместе с другими. */
  const err = new ContextOverflowError("m", 1, 0);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ContextOverflowError);
});

test("[overflow-guard] ContextOverflowError: error.message включает все числа в правильном порядке", () => {
  /* Регрессия-страж: если кто-то поменяет required<->available в конструкторе,
     diagnostic в logs будет вводить в заблуждение. */
  const err = new ContextOverflowError("qwen3-4b", 15000, 8192);
  assert.match(err.message, /required 15000/);
  assert.match(err.message, /available 8192/);
});
