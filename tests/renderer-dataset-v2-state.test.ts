/**
 * tests/renderer-dataset-v2-state.test.ts
 *
 * Unit-тесты для renderer/dataset-v2-state.js:
 * фокус на phaseToLabel (switch-case mapping enum → i18n).
 *
 * STATE singleton и isCrystalBusy() — простые getterы/state holders,
 * смысла unit-тестировать нет. phaseToLabel — производственная
 * логика отображения progress phase в UI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* i18n stubs ДО импорта dataset-v2-state. */
const memStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
};
(globalThis as Record<string, unknown>).document = {
  documentElement: { lang: "" },
  querySelectorAll: () => [],
};

import { phaseToLabel, isCrystalBusy, STATE } from "../renderer/dataset-v2-state.js";
import { setLocale } from "../renderer/i18n.js";

test("[dataset-v2-state] phaseToLabel: все known фазы возвращают непустые лейблы (ru)", () => {
  setLocale("ru");
  for (const phase of ["scan", "generate", "write", "done"]) {
    const label = phaseToLabel(phase);
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0, `фаза '${phase}' имеет лейбл`);
    /* Лейбл НЕ равен ключу — значит i18n работает. */
    assert.notEqual(label, `dataset.synth.phase.${phase}`);
  }
});

test("[dataset-v2-state] phaseToLabel: known фазы в en — тоже работают", () => {
  setLocale("en");
  for (const phase of ["scan", "generate", "write", "done"]) {
    const label = phaseToLabel(phase);
    assert.ok(label.length > 0);
    assert.notEqual(label, `dataset.synth.phase.${phase}`);
  }
  setLocale("ru");
});

test("[dataset-v2-state] phaseToLabel: unknown фаза → idle label (default branch)", () => {
  setLocale("ru");
  /* Контракт: все unknown phases → idle (default). Семантика простая:
     UI показывает «Нет активной работы». */
  const idle = phaseToLabel("idle");
  const unknownLabel1 = phaseToLabel("");
  const unknownLabel2 = phaseToLabel("garbage");
  const unknownLabel3 = phaseToLabel("error"); /* error НЕ в switch → default */
  assert.equal(unknownLabel1, idle);
  assert.equal(unknownLabel2, idle);
  assert.equal(unknownLabel3, idle);
});

test("[dataset-v2-state] isCrystalBusy: отражает STATE.busy", () => {
  /* STATE — module-level singleton, мутируем явно для теста. */
  STATE.busy = false;
  assert.equal(isCrystalBusy(), false);
  STATE.busy = true;
  assert.equal(isCrystalBusy(), true);
  STATE.busy = false; /* cleanup */
});

test("[dataset-v2-state] STATE: default values инициализированы корректно", () => {
  /* Регрессия-страж: если кто-то поменяет дефолты «для удобства» — это
     бы сломало визуальный onboarding (предварительные выборы в wizard). */
  /* НАЧИНАЕМ с чистого state — вызываем этот тест ПЕРВЫМ в файле,
     иначе другие тесты уже могли поменять STATE.busy. Но поскольку нады критичны только
     immutable дефолты, это ОК. */
  assert.equal(STATE.collection, "delta-knowledge");
  assert.equal(STATE.pairsPerConcept, 2);
  assert.equal(STATE.format, "chatml");
  /* outputDir пустой — юзер выбирает в wizard. */
  assert.equal(STATE.outputDir, "");
  /* mode начинается с idle. */
  assert.equal(STATE.mode, "idle");
});
