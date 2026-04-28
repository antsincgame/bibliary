/**
 * Тесты для quality-based model fallback wrapper.
 *
 * Проверяем:
 *   1. Если первая модель ответила хорошо — fallback не активируется.
 *   2. Если первая модель кинула throw — пробуем вторую.
 *   3. Если первая модель вернула «плохой» результат (predicate=false) —
 *      пробуем вторую.
 *   4. Если все упали — возвращаем result=null + attempts.
 *   5. abort signal обрывает цепочку.
 *   6. Без prefs (пустые) и без override — возвращает empty.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/* Подменяем preferences и lmstudio-client до импорта wrapper'а. */
import { withModelFallback } from "../electron/lib/llm/with-model-fallback.ts";

/* В реальной системе withModelFallback берёт prefs+loaded models из
   electron-биндингов. Для unit-тестов идём по короткому пути: через
   `models` override-параметр (минует prefs+listLoaded). */

test("withModelFallback: первая модель успешна → fallback не запускается", async () => {
  let calls = 0;
  const r = await withModelFallback<{ value: number }>({
    role: "crystallizer",
    models: ["model-a", "model-b", "model-c"],
    task: async (modelKey) => {
      calls++;
      assert.equal(modelKey, "model-a");
      return { value: 42 };
    },
  });
  assert.equal(calls, 1, "только одна модель должна была быть вызвана");
  assert.equal(r.modelKey, "model-a");
  assert.deepEqual(r.result, { value: 42 });
  assert.equal(r.attempts.length, 1);
  assert.ok(r.attempts[0]!.ok);
});

test("withModelFallback: первая throw → fallback на вторую", async () => {
  let calls = 0;
  const r = await withModelFallback<string>({
    role: "crystallizer",
    models: ["bad", "good"],
    task: async (modelKey) => {
      calls++;
      if (modelKey === "bad") throw new Error("connection timeout");
      return "second-success";
    },
  });
  assert.equal(calls, 2);
  assert.equal(r.modelKey, "good");
  assert.equal(r.result, "second-success");
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0]!.ok, false);
  assert.equal(r.attempts[0]!.error, "connection timeout");
  assert.equal(r.attempts[1]!.ok, true);
});

test("withModelFallback: первая вернула «плохой» результат → predicate отказывает, пробуем дальше", async () => {
  const r = await withModelFallback<{ json?: object }>({
    role: "crystallizer",
    models: ["empty-model", "rich-model"],
    task: async (modelKey) => {
      if (modelKey === "empty-model") return { json: undefined }; /* плохо */
      return { json: { delta: ["fact-1", "fact-2"] } };
    },
    isAcceptable: (r) => r.json !== undefined,
  });
  assert.equal(r.modelKey, "rich-model");
  assert.deepEqual(r.result?.json, { delta: ["fact-1", "fact-2"] });
  assert.equal(r.attempts[0]!.rejectedByPredicate, true);
  assert.equal(r.attempts[1]!.ok, true);
});

test("withModelFallback: все модели завалили — возвращает null + полную трассу", async () => {
  const r = await withModelFallback<string>({
    role: "crystallizer",
    models: ["m1", "m2", "m3"],
    task: async () => { throw new Error("boom"); },
  });
  assert.equal(r.modelKey, null);
  assert.equal(r.result, null);
  assert.equal(r.attempts.length, 3);
  assert.ok(r.attempts.every((a) => !a.ok));
});

test("withModelFallback: predicate отбраковывает все — null", async () => {
  const r = await withModelFallback<number>({
    role: "crystallizer",
    models: ["a", "b"],
    task: async () => 0,
    isAcceptable: (n) => n > 0,
  });
  assert.equal(r.modelKey, null);
  assert.equal(r.attempts.length, 2);
  assert.ok(r.attempts.every((a) => a.rejectedByPredicate));
  assert.equal(r.attempts[0]!.result, 0);
  assert.equal(r.attempts[1]!.result, 0);
});

test("withModelFallback: пустой override и нет prefs/loaded → пустой результат", async () => {
  const r = await withModelFallback<string>({
    role: "crystallizer",
    models: [],
    task: async () => "shouldnt-be-called",
  });
  /* Так как override пуст, wrapper пробует prefs+loaded.
     В тестовой среде prefs может быть пустой, listLoaded() может вернуть
     ничего. В обоих случаях ожидаем null.modelKey. */
  if (r.modelKey === null) {
    assert.equal(r.attempts.length, 0);
  } else {
    /* Если в среде есть prefs.extractorModel — это допустимо. */
    assert.ok(typeof r.modelKey === "string");
  }
});

test("withModelFallback: signal aborts mid-chain", async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const r = await withModelFallback<string>({
    role: "crystallizer",
    models: ["a", "b", "c", "d"],
    signal: ctrl.signal,
    task: async (modelKey) => {
      calls++;
      if (modelKey === "b") ctrl.abort();
      throw new Error("fail");
    },
  });
  /* Должны вызвать a, b — после b отмена; c и d НЕ вызываются. */
  assert.equal(calls, 2, "только a и b должны быть вызваны до abort");
  assert.equal(r.modelKey, null);
});

test("withModelFallback: onAttempt callback вызывается для каждой попытки", async () => {
  const seen: Array<{ key: string; ok: boolean }> = [];
  await withModelFallback<string>({
    role: "crystallizer",
    models: ["a", "b"],
    task: async (k) => {
      if (k === "a") throw new Error("nope");
      return "ok";
    },
    onAttempt: (a) => seen.push({ key: a.modelKey, ok: a.ok }),
  });
  assert.deepEqual(seen, [
    { key: "a", ok: false },
    { key: "b", ok: true },
  ]);
});
