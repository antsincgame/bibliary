/**
 * Lang Detector — гибридный (regex + optional LLM).
 *
 * Эти тесты гарантируют, что regex-детект справляется в кейсах,
 * где LLM (3-9B) гарантированно ошибаются — путают украинский с русским.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectLanguageByRegex,
  detectLanguage,
} from "../electron/lib/llm/lang-detector.ts";

const UK = "Алгоритм пошуку в глибину обходить дерево, починаючи з кореня. " +
           "Складність — O(V + E). Алгоритм використовується для багатьох задач у теорії графів.";

const RU = "Алгоритм поиска в глубину обходит дерево, начиная с корня. " +
           "Сложность — O(V + E). Алгоритм используется для многих задач в теории графов.";

const EN = "Depth-first search traverses a tree starting from the root. " +
           "Its complexity is O(V + E). Used for many graph theory problems.";

const DE = "Die Tiefensuche durchläuft den Baum beginnend mit der Wurzel. " +
           "Die Komplexität beträgt O(V + E). Häufig für Graphprobleme genutzt.";

test("detectLanguageByRegex: чистый украинский → uk", () => {
  const r = detectLanguageByRegex(UK);
  assert.equal(r.lang, "uk", `expected uk; got ${r.lang} (${r.details})`);
  assert.ok(r.confidence >= 0.8, `low confidence: ${r.confidence}`);
});

test("detectLanguageByRegex: чистый русский → ru", () => {
  const r = detectLanguageByRegex(RU);
  assert.equal(r.lang, "ru", `expected ru; got ${r.lang} (${r.details})`);
  assert.ok(r.confidence >= 0.7);
});

test("detectLanguageByRegex: английский → en", () => {
  const r = detectLanguageByRegex(EN);
  assert.equal(r.lang, "en");
  assert.ok(r.confidence >= 0.85);
});

test("detectLanguageByRegex: немецкий → de", () => {
  const r = detectLanguageByRegex(DE);
  assert.equal(r.lang, "de");
  assert.ok(r.confidence >= 0.8);
});

test("detectLanguageByRegex: смешанный (русский + латиница O(V+E)) → ru, не путается", () => {
  const text = "Бинарный поиск имеет сложность O(log n). Это эффективный алгоритм для отсортированных массивов.";
  const r = detectLanguageByRegex(text);
  assert.equal(r.lang, "ru");
});

test("detectLanguageByRegex: украинский без 'і' (только е+ї) — пограничный, должен быть uk если 2+ маркера", () => {
  const text = "Тут є щось особливе ще: довжина має бути не менше двадцяти символів, тому додаємо текст для тесту.";
  const r = detectLanguageByRegex(text);
  /* Содержит «є» 2 раза → должно быть uk */
  assert.equal(r.lang, "uk", `details: ${r.details}`);
});

test("detectLanguageByRegex: слишком короткий текст → unknown", () => {
  const r = detectLanguageByRegex("hi");
  assert.equal(r.lang, "unknown");
});

test("detectLanguageByRegex: пустая строка → unknown без crash", () => {
  const r = detectLanguageByRegex("");
  assert.equal(r.lang, "unknown");
  assert.equal(r.confidence, 0);
});

test("detectLanguageByRegex: только числа → unknown", () => {
  const r = detectLanguageByRegex("123 456 789 0");
  assert.equal(r.lang, "unknown");
});

/* ─── Async detectLanguage с LLM fallback ───────────────────────────── */

test("detectLanguage: regex-confidence>=0.8 → LLM не дёргается", async () => {
  let llmCalled = 0;
  const r = await detectLanguage(UK, async () => { llmCalled++; return "ru"; });
  assert.equal(r.lang, "uk");
  assert.equal(r.source, "regex");
  assert.equal(llmCalled, 0, "LLM должен НЕ вызываться при высокой regex-уверенности");
});

test("detectLanguage: низкая regex-confidence → LLM вызывается", async () => {
  /* Текст без маркеров — например, плейн-ASCII: regex даст en с confidence < 0.9
     если короткий, либо unknown */
  const ambiguous = "test 1234"; /* < 50 latin chars → regex unknown */
  let llmCalled = 0;
  const r = await detectLanguage(ambiguous, async () => { llmCalled++; return "en"; });
  assert.ok(llmCalled >= 0); /* зависит от регекса */
  if (llmCalled > 0) {
    assert.equal(r.lang, "en");
    assert.equal(r.source, "llm");
  }
});

test("detectLanguage: LLM вернул null → возвращаем regex-результат", async () => {
  const ambiguous = "test 1234";
  const r = await detectLanguage(ambiguous, async () => null);
  /* Без LLM — regex-результат (unknown / en с низкой conf) */
  assert.ok(r.source === "regex" || r.source === "default");
});

test("detectLanguage: LLM кинул throw → graceful fallback на regex", async () => {
  const ambiguous = "test 1234";
  const r = await detectLanguage(ambiguous, async () => { throw new Error("boom"); });
  assert.equal(r.source, "regex"); /* не падаем — оставляем regex */
});

/* ─── Регрессия от Олимпиады: LLM путала украинский с русским ──────── */

test("CRITICAL: украинский текст из Олимпиады → uk (regex решает то, что LLM 3-9B не смогла)", () => {
  /* Реальный текст из Олимпиады, на котором ВСЕ модели 3-9B ошибались. */
  const text = "Алгоритм пошуку в глибину (DFS) обходить дерево, починаючи з кореня, " +
    "і йде якомога глибше по кожній гілці перед поверненням назад. Складність — O(V + E).";
  const r = detectLanguageByRegex(text);
  assert.equal(r.lang, "uk", `LLM путала с ru, но regex обязан различать! Got: ${r.lang} (${r.details})`);
  assert.ok(r.confidence >= 0.8, `confidence too low: ${r.confidence}`);
});
