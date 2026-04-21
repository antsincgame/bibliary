/**
 * Phase 3 Удар 2 — unit-тесты для pickBestModel из renderer/components/model-select.js
 *
 * Покрывает чистую (без DOM) логику выбора лучшей модели по подсказкам.
 * Запуск:  npx tsx scripts/test-model-select.ts
 */

// Импортируем напрямую из JS-файла. tsx умеет резолвить .js → исходник.
import { pickBestModel, DEFAULT_MODEL_HINTS } from "../renderer/components/model-select.js";

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(label: string, fn: () => void): void {
  process.stdout.write(`  ${label.padEnd(70, ".")} `);
  try {
    fn();
    console.log(`${COLOR.green}PASS${COLOR.reset}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${COLOR.red}FAIL${COLOR.reset}\n      ${COLOR.dim}${msg}${COLOR.reset}`);
    failed++;
    failures.push(label);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log(`${COLOR.bold}== Bibliary model-select unit tests ==${COLOR.reset}\n`);

// ----- B.1-1 — пустой список → пустая строка -----
test("B.1-1 — пустой список моделей возвращает пустую строку", () => {
  eq(pickBestModel([]), "", "empty list");
  // @ts-expect-error — намеренно проверяем robust к null/undefined
  eq(pickBestModel(null), "", "null input");
  // @ts-expect-error — non-array
  eq(pickBestModel(undefined), "", "undefined input");
});

// ----- B.1-2 — первая подсказка с приоритетом -----
test("B.1-2 — первая совпадающая подсказка побеждает", () => {
  const models = [
    { modelKey: "meta-llama/llama-3.2-3b" },
    { modelKey: "qwen/qwen3.6-35b-a3b" },
    { modelKey: "mistralai/mistral-small-3.1" },
  ];
  // DEFAULT: ["qwen3.6", "qwen3-coder", "mistral-small", "qwen3.5", "qwen", "llama"]
  // qwen3.6 → matches "qwen/qwen3.6-35b-a3b"
  eq(pickBestModel(models), "qwen/qwen3.6-35b-a3b", "qwen3.6 highest priority");
});

// ----- B.1-3 — fallback на следующую подсказку если первой нет -----
test("B.1-3 — fallback на следующую подсказку", () => {
  const models = [
    { modelKey: "meta-llama/llama-3.2-3b" },
    { modelKey: "mistralai/mistral-small-3.1" },
  ];
  // qwen3.6 нет, qwen3-coder нет, mistral-small есть → должна победить
  eq(pickBestModel(models), "mistralai/mistral-small-3.1", "mistral-small picked");
});

// ----- B.1-4 — ни одна подсказка не сматчилась → первая модель -----
test("B.1-4 — без матчей возвращается первая модель", () => {
  const models = [
    { modelKey: "google/gemma-2-9b" },
    { modelKey: "microsoft/phi-3-mini" },
  ];
  eq(pickBestModel(models), "google/gemma-2-9b", "fallback to first");
});

// ----- B.1-5 — case-insensitive matching -----
test("B.1-5 — case-insensitive substring match", () => {
  const models = [
    { modelKey: "Qwen/Qwen3.6-Coder-30B-A3B" }, // верхний регистр
  ];
  eq(pickBestModel(models), "Qwen/Qwen3.6-Coder-30B-A3B", "matches case-insensitively");
});

// ----- B.1-6 — кастомные hints перекрывают defaults -----
test("B.1-6 — кастомные hints используются вместо DEFAULT_MODEL_HINTS", () => {
  const models = [
    { modelKey: "qwen/qwen3.6-35b" }, // default бы выбрал это
    { modelKey: "google/gemma-2-9b" },
  ];
  // Кастомный hints — gemma первым
  eq(pickBestModel(models, ["gemma", "qwen"]), "google/gemma-2-9b", "custom hints respected");
});

// ----- B.1-7 — пустой массив hints → fallback на первую модель -----
test("B.1-7 — пустые hints не падают, fallback на первую", () => {
  const models = [{ modelKey: "any/model-x" }, { modelKey: "any/model-y" }];
  eq(pickBestModel(models, []), "any/model-x", "empty hints fallback");
});

// ----- B.1-8 — модель без modelKey не выбирается, переходим дальше -----
test("B.1-8 — отсутствующий modelKey игнорируется", () => {
  const models = [
    // @ts-expect-error — намеренно битая запись
    { modelKey: undefined },
    { modelKey: "qwen/qwen3.6-35b" },
  ];
  eq(pickBestModel(models), "qwen/qwen3.6-35b", "skips missing modelKey");
});

// ----- B.1-9 — DEFAULT_MODEL_HINTS экспортируется и содержит ожидаемые ключи -----
test("B.1-9 — DEFAULT_MODEL_HINTS содержит критичные подсказки", () => {
  assert(Array.isArray(DEFAULT_MODEL_HINTS), "exported as array");
  assert(DEFAULT_MODEL_HINTS.length >= 3, "has ≥3 hints");
  assert(DEFAULT_MODEL_HINTS.includes("qwen"), "includes qwen fallback");
  assert(DEFAULT_MODEL_HINTS.includes("llama"), "includes llama fallback");
  // qwen3.6 должен быть РАНЬШЕ чем общий "qwen" (specificity)
  const idxSpecific = DEFAULT_MODEL_HINTS.indexOf("qwen3.6");
  const idxGeneric = DEFAULT_MODEL_HINTS.indexOf("qwen");
  assert(idxSpecific !== -1, "qwen3.6 listed");
  assert(idxSpecific < idxGeneric, "qwen3.6 has higher priority than generic qwen");
});

// ----- B.1-10 — поведение детерминировано (один и тот же вход → один и тот же выход) -----
test("B.1-10 — детерминированный вывод для одного входа", () => {
  const models = [
    { modelKey: "qwen/qwen3.6-35b" },
    { modelKey: "qwen/qwen3.6-coder-30b" }, // оба матчат qwen3.6
  ];
  const r1 = pickBestModel(models);
  const r2 = pickBestModel(models);
  const r3 = pickBestModel(models);
  eq(r1, r2, "run 1 vs 2 stable");
  eq(r2, r3, "run 2 vs 3 stable");
  // .find() возвращает первый match → "qwen/qwen3.6-35b"
  eq(r1, "qwen/qwen3.6-35b", "first match wins");
});

// ----- Summary -----
console.log(`\n${COLOR.bold}--- Summary ---${COLOR.reset}`);
console.log(`Tests passed: ${COLOR.green}${passed}${COLOR.reset}`);
console.log(`Tests failed: ${failed === 0 ? COLOR.green : COLOR.red}${failed}${COLOR.reset}`);
if (failed > 0) {
  console.log(`\n${COLOR.red}Failed:${COLOR.reset}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
