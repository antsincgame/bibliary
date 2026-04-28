/**
 * Unit-тесты на buildPromptWithGuard — критичная защита от
 * long-context degradation в delta-extractor.
 *
 * Проверяем:
 *   1. Маленький chunk → prompt без truncation
 *   2. Гигантский chunk → prompt усечён, флаг truncated=true
 *   3. Подстановка all-{{XXX}} placeholders работает
 *   4. memory.ledEssences присутствуют в prompt
 *   5. overlapText используется когда есть, иначе memoryBlock
 *   6. кастомный maxChars применяется
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptWithGuard } from "../electron/lib/dataset-v2/delta-extractor.ts";
import type { ChapterMemory, SemanticChunk } from "../electron/lib/dataset-v2/types.ts";

const TEMPLATE = `Breadcrumb: {{BREADCRUMB}}
Thesis: {{CHAPTER_THESIS}}
Domains: {{ALLOWED_DOMAINS}}
Context: {{OVERLAP_CONTEXT}}

CHUNK:
{{CHUNK_TEXT}}

End.`;

function mkChunk(overrides: Partial<SemanticChunk> = {}): SemanticChunk {
  return {
    chapterTitle: "Chapter 1",
    breadcrumb: "Book > Ch.1",
    partN: 1,
    partTotal: 1,
    text: "Lorem ipsum dolor sit amet.",
    overlapText: "",
    ...overrides,
  };
}

const EMPTY_MEMORY: ChapterMemory = { ledEssences: [], lastThesis: "" };

test("buildPromptWithGuard: малый chunk → не усекается", () => {
  const chunk = mkChunk({ text: "Short content." });
  const r = buildPromptWithGuard(TEMPLATE, chunk, "thesis-1", EMPTY_MEMORY);
  assert.equal(r.truncated, false);
  assert.equal(r.chunkCharsUsed, "Short content.".length);
  assert.match(r.prompt, /Short content\./);
  assert.match(r.prompt, /Breadcrumb: Book > Ch\.1/);
  assert.match(r.prompt, /Thesis: thesis-1/);
});

test("buildPromptWithGuard: гигантский chunk → усекается до cap, truncated=true", () => {
  const huge = "A".repeat(50_000); /* > default cap of 24000 */
  const r = buildPromptWithGuard(TEMPLATE, mkChunk({ text: huge }), "thesis", EMPTY_MEMORY);
  assert.equal(r.truncated, true);
  assert.ok(r.chunkCharsUsed < 50_000, `chunkCharsUsed should be capped, got ${r.chunkCharsUsed}`);
  assert.ok(r.chunkCharsUsed >= 2000, "even after truncation, must keep >=2000 chars");
  /* Маркер в усечённом тексте */
  assert.match(r.prompt, /отрезано: текст чанка превышал безопасный размер/);
});

test("buildPromptWithGuard: подстановка ALLOWED_DOMAINS даёт непустую строку", () => {
  const r = buildPromptWithGuard(TEMPLATE, mkChunk(), "t", EMPTY_MEMORY);
  /* domain list — не пустой и не плейсхолдер */
  assert.ok(!/\{\{ALLOWED_DOMAINS\}\}/.test(r.prompt), "placeholder should be replaced");
  /* Извлекаем «Domains: ...» */
  const m = r.prompt.match(/Domains: (.+)/);
  assert.ok(m, `expected Domains line; prompt: ${r.prompt.slice(0, 200)}`);
  assert.ok(m![1].length > 0, "domains line should be non-empty");
});

test("buildPromptWithGuard: memory.ledEssences попадают в OVERLAP_CONTEXT блок", () => {
  const memory: ChapterMemory = {
    ledEssences: ["fact-A about big-O", "fact-B about hash maps"],
    lastThesis: "previous",
  };
  const r = buildPromptWithGuard(TEMPLATE, mkChunk(), "thesis", memory);
  assert.match(r.prompt, /Already extracted from earlier chunks/);
  assert.match(r.prompt, /fact-A about big-O/);
  assert.match(r.prompt, /fact-B about hash maps/);
  assert.match(r.prompt, /Do NOT repeat these/);
});

test("buildPromptWithGuard: overlapText из chunk вытесняет memory block", () => {
  const memory: ChapterMemory = {
    ledEssences: ["should-NOT-appear"],
    lastThesis: "",
  };
  const chunk = mkChunk({ overlapText: "previous chunk ending here" });
  const r = buildPromptWithGuard(TEMPLATE, chunk, "t", memory);
  assert.match(r.prompt, /Context from end of previous chunk/);
  assert.match(r.prompt, /previous chunk ending here/);
  /* Memory НЕ показывается, т.к. overlap имеет приоритет. */
  assert.ok(!/should-NOT-appear/.test(r.prompt), "memory must not leak when overlap is present");
});

test("buildPromptWithGuard: кастомный maxChars соблюдается", () => {
  const text = "X".repeat(10_000);
  /* Минимальный cap = 2000, поэтому ставим 3000 */
  const r = buildPromptWithGuard(TEMPLATE, mkChunk({ text }), "t", EMPTY_MEMORY, 3000);
  assert.equal(r.truncated, true);
  assert.ok(r.chunkCharsUsed <= 3000, `chunkCharsUsed=${r.chunkCharsUsed} should be ≤ 3000`);
  assert.ok(r.prompt.length <= 3500, `prompt total length=${r.prompt.length} should be ≈3000+overhead`);
});

test("buildPromptWithGuard: нет {{CHUNK_TEXT}} в финальном prompt (placeholder заменён)", () => {
  const r = buildPromptWithGuard(TEMPLATE, mkChunk(), "t", EMPTY_MEMORY);
  for (const ph of ["{{CHUNK_TEXT}}", "{{BREADCRUMB}}", "{{CHAPTER_THESIS}}", "{{OVERLAP_CONTEXT}}", "{{ALLOWED_DOMAINS}}"]) {
    assert.ok(!r.prompt.includes(ph), `placeholder ${ph} should be replaced`);
  }
});

test("buildPromptWithGuard: floor 2000 — даже при крошечном maxChars chunk получает минимум 2k", () => {
  /* Невозможные настройки: maxChars=500, чанк длинный */
  const text = "Y".repeat(5000);
  const r = buildPromptWithGuard(TEMPLATE, mkChunk({ text }), "t", EMPTY_MEMORY, 500);
  /* Floor=2000 — гарантирует что мы не «убиваем» весь chunk до нуля. */
  assert.ok(r.chunkCharsUsed >= 2000, `floor not respected: chunkCharsUsed=${r.chunkCharsUsed}`);
});
