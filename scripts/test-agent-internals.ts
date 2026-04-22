/**
 * scripts/test-agent-internals.ts — unit-тесты к функциям, добавленным
 * в B1 (multiturn history) и B7 (long-term memory). Без сети, без LM Studio,
 * без Qdrant — чисто детерминированная проверка контракта.
 *
 * Покрытие:
 *   - sanitizeAgentHistory: фильтрация мусора, cap, sub-cap, не-массив
 *   - deterministicId: стабильность, uuid-v4 формат, разные seed → разные id
 *   - shouldRemember: длина, ⚠/error префикс, граничные значения
 *   - buildMemoryText: формат "Q: ... A: ...", truncation
 *
 * Запуск: npx tsx scripts/test-agent-internals.ts
 */

import {
  sanitizeAgentHistory,
  DEFAULT_HISTORY_CAP,
} from "../electron/lib/agent/history-sanitize.js";
import {
  deterministicId,
  shouldRemember,
  buildMemoryText,
  MIN_REMEMBER_CHARS,
  MAX_MEMORY_TEXT_CHARS,
  type MemoryEntry,
} from "../electron/lib/help-kb/memory.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function step(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  FAIL  ${name}\n        ${msg}`);
    failed += 1;
    failures.push(`${name}: ${msg}`);
  }
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

console.log("\n== sanitizeAgentHistory ==\n");

step("не-массив возвращает []", () => {
  assertEq(sanitizeAgentHistory(null), [], "null");
  assertEq(sanitizeAgentHistory(undefined), [], "undefined");
  assertEq(sanitizeAgentHistory("foo"), [], "string");
  assertEq(sanitizeAgentHistory({ role: "user", content: "x" }), [], "object");
});

step("выкидывает null/не-объекты внутри массива", () => {
  const out = sanitizeAgentHistory([
    null,
    undefined,
    "string",
    42,
    { role: "user", content: "ok" },
  ]);
  assertEq(out, [{ role: "user", content: "ok" }], "filtered");
});

step("отфильтровывает невалидные роли", () => {
  const out = sanitizeAgentHistory([
    { role: "system", content: "system msg" },
    { role: "tool", content: "tool result" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  assertEq(out, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ], "roles filter");
});

step("отбрасывает пустой/не-строковый content", () => {
  const out = sanitizeAgentHistory([
    { role: "user", content: "" },
    { role: "user", content: 123 },
    { role: "user", content: null },
    { role: "user", content: undefined },
    { role: "assistant", content: "valid" },
  ]);
  assertEq(out, [{ role: "assistant", content: "valid" }], "content filter");
});

step("cap по умолчанию = 50, режется FIFO (последние)", () => {
  const big = Array.from({ length: 75 }, (_, i) => ({
    role: i % 2 === 0 ? "user" as const : "assistant" as const,
    content: `msg-${i}`,
  }));
  const out = sanitizeAgentHistory(big);
  assertEq(out.length, DEFAULT_HISTORY_CAP, "length");
  assertEq(out[0].content, "msg-25", "first kept");
  assertEq(out[out.length - 1].content, "msg-74", "last kept");
});

step("custom cap уважается", () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({
    role: "user" as const,
    content: `m${i}`,
  }));
  const out = sanitizeAgentHistory(ten, 3);
  assertEq(out.length, 3, "cap=3");
  assertEq(out.map((m) => m.content), ["m7", "m8", "m9"], "tail-3");
});

step("cap <=0 или NaN → дефолт", () => {
  const arr = Array.from({ length: 60 }, () => ({ role: "user" as const, content: "x" }));
  assertEq(sanitizeAgentHistory(arr, 0).length, DEFAULT_HISTORY_CAP, "zero");
  assertEq(sanitizeAgentHistory(arr, -5).length, DEFAULT_HISTORY_CAP, "negative");
  assertEq(sanitizeAgentHistory(arr, Number.NaN).length, DEFAULT_HISTORY_CAP, "NaN");
});

step("сообщения короче cap не теряются", () => {
  const out = sanitizeAgentHistory([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ]);
  assertEq(out.length, 2, "short kept");
});

console.log("\n== deterministicId ==\n");

step("стабилен для одного seed", () => {
  const a = deterministicId("seed-1");
  const b = deterministicId("seed-1");
  assertEq(a, b, "same seed → same id");
});

step("разный seed → разный id", () => {
  const a = deterministicId("seed-1");
  const b = deterministicId("seed-2");
  assert(a !== b, `expected different ids, both = ${a}`);
});

step("выглядит как uuid-v4 (8-4-4-4-12, '4' и '8' маркеры)", () => {
  const id = deterministicId("any");
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
  assert(uuidRe.test(id), `uuid format: got ${id}`);
});

step("устойчив к unicode/длинным seed", () => {
  const id1 = deterministicId("ω".repeat(10_000));
  const id2 = deterministicId("ω".repeat(10_000));
  assertEq(id1, id2, "unicode stable");
});

console.log("\n== shouldRemember ==\n");

const longU = "вопрос ".repeat(10);
const longA = "ответ ".repeat(10);
const baseEntry: MemoryEntry = {
  ts: "2026-01-01T00:00:00Z",
  userMessage: longU,
  assistantAnswer: longA,
};

step("валидная пара → true", () => {
  assertEq(shouldRemember(baseEntry), true, "valid");
});

step("слишком короткий user → false", () => {
  assertEq(shouldRemember({ ...baseEntry, userMessage: "hi" }), false, "short user");
});

step("слишком короткий assistant → false", () => {
  assertEq(shouldRemember({ ...baseEntry, assistantAnswer: "ok" }), false, "short asst");
});

step("граница MIN_REMEMBER_CHARS — ровно", () => {
  /* Длина MIN_REMEMBER_CHARS — должна проходить (>=) */
  const exact = "x".repeat(MIN_REMEMBER_CHARS);
  assertEq(
    shouldRemember({ ts: "t", userMessage: exact, assistantAnswer: exact }),
    true,
    "exact min ok",
  );
  /* Длина MIN_REMEMBER_CHARS - 1 — НЕ должна проходить */
  const short = "x".repeat(MIN_REMEMBER_CHARS - 1);
  assertEq(
    shouldRemember({ ts: "t", userMessage: short, assistantAnswer: exact }),
    false,
    "below min rejected",
  );
});

step("ответ с ⚠ префиксом не запоминается", () => {
  assertEq(
    shouldRemember({ ...baseEntry, assistantAnswer: "⚠ что-то пошло не так очень плохо" }),
    false,
    "warning rejected",
  );
});

step("ответ начинающийся с 'Ошибка' / 'error' не запоминается", () => {
  assertEq(
    shouldRemember({ ...baseEntry, assistantAnswer: "Ошибка: соединение не установлено надолго" }),
    false,
    "ru error rejected",
  );
  assertEq(
    shouldRemember({ ...baseEntry, assistantAnswer: "Error: connection refused, please retry later" }),
    false,
    "en error rejected",
  );
});

step("trim применяется до проверки длины", () => {
  /* Pad whitespace должен схлопываться trim'ом → пустая строка должна резаться */
  assertEq(
    shouldRemember({ ts: "t", userMessage: "   ".repeat(50), assistantAnswer: longA }),
    false,
    "whitespace user",
  );
});

console.log("\n== buildMemoryText ==\n");

step("формат 'Q: ... A: ...'", () => {
  const text = buildMemoryText({
    ts: "t",
    userMessage: "Что такое YaRN?",
    assistantAnswer: "Метод расширения контекста через RoPE scaling.",
  });
  assert(text.startsWith("Q: Что такое YaRN?"), `bad prefix: ${text.slice(0, 40)}`);
  assert(text.includes("\nA: Метод расширения"), "missing A: segment");
});

step("каждая сторона ограничена MAX_MEMORY_TEXT_CHARS/2", () => {
  const half = MAX_MEMORY_TEXT_CHARS / 2;
  const huge = "z".repeat(half + 500);
  const text = buildMemoryText({ ts: "t", userMessage: huge, assistantAnswer: huge });
  /* "Q: " (3) + half + "\nA: " (4) + half */
  assertEq(text.length, 3 + half + 4 + half, "total length");
});

step("trim'ит whitespace на границах", () => {
  const text = buildMemoryText({
    ts: "t",
    userMessage: "  question  ",
    assistantAnswer: "  answer  ",
  });
  assertEq(text, "Q: question\nA: answer", "trimmed");
});

console.log("\n--- Summary ---");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
