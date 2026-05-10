/**
 * tests/evaluator-mapping.test.ts
 *
 * Unit-тесты для buildEvaluatedMeta + buildEvaluatorDoneEvent.
 *
 * Mapping BookEvaluation (snake_case JSON от LLM) → BookCatalogMeta
 * (camelCase для cache-db + frontmatter) — самая частая регрессия
 * evaluator pipeline. Раньше эта логика жила inline в slot-worker
 * без unit-тестов: регрессия типа «перепутали qualityScore с
 * conceptualDensity» проходила бы тихо до production.
 *
 * После extract'а в evaluator-mapping.ts можно тестировать через
 * простые объекты без cache-db / Electron / реального evaluator pipeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEvaluatedMeta,
  buildEvaluatorDoneEvent,
} from "../electron/lib/library/evaluator-mapping.ts";
import type { BookCatalogMeta, BookEvaluation, EvaluationResult } from "../electron/lib/library/types.ts";

/* ─── Fixtures ────────────────────────────────────────────────────── */

function makeBaseMeta(overrides: Partial<BookCatalogMeta> = {}): BookCatalogMeta {
  return {
    id: "book-abc",
    sha256: "a".repeat(64),
    originalFile: "book.pdf",
    originalFormat: "pdf",
    title: "Book Title",
    wordCount: 1000,
    chapterCount: 10,
    status: "imported",
    ...overrides,
  };
}

function makeEvaluation(overrides: Partial<BookEvaluation> = {}): BookEvaluation {
  return {
    title_ru: "Кибернетика",
    author_ru: "Винер Н.",
    title_en: "Cybernetics",
    author_en: "Wiener N.",
    year: 1948,
    domain: "cybernetics",
    tags: ["a", "b", "c", "d", "e", "f", "g", "h"],
    tags_ru: ["а", "б", "в", "г", "д", "е", "ж", "з"],
    is_fiction_or_water: false,
    conceptual_density: 88,
    originality: 95,
    quality_score: 92,
    verdict_reason: "Foundational work in cybernetics, very high density.",
    ...overrides,
  };
}

function makeResult(evaluation: BookEvaluation | null, overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    evaluation,
    reasoning: "The book exhibits foundational characteristics...",
    raw: "<think>...</think>{...}",
    model: "qwen3-4b",
    warnings: [],
    ...overrides,
  };
}

/* ─── buildEvaluatedMeta: basic mapping ───────────────────────────── */

test("[evaluator-mapping] buildEvaluatedMeta: всё mapping correctly snake_case → camelCase", () => {
  const baseMeta = makeBaseMeta();
  const ev = makeEvaluation();
  const result = makeResult(ev);
  const updated = buildEvaluatedMeta({ baseMeta, result, evaluatedAt: "2026-05-10T12:00:00.000Z" });

  /* title/author RU+EN */
  assert.equal(updated.titleRu, "Кибернетика");
  assert.equal(updated.authorRu, "Винер Н.");
  assert.equal(updated.titleEn, "Cybernetics");
  assert.equal(updated.authorEn, "Wiener N.");

  /* year, domain */
  assert.equal(updated.year, 1948);
  assert.equal(updated.domain, "cybernetics");

  /* tags arrays */
  assert.deepEqual(updated.tags, ["a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.deepEqual(updated.tagsRu, ["а", "б", "в", "г", "д", "е", "ж", "з"]);

  /* Три похожих 0-100 поля — регрессия-страж от перепутывания. */
  assert.equal(updated.qualityScore, 92);
  assert.equal(updated.conceptualDensity, 88);
  assert.equal(updated.originality, 95);

  /* Boolean is_fiction_or_water */
  assert.equal(updated.isFictionOrWater, false);

  /* verdict_reason → verdictReason */
  assert.equal(updated.verdictReason, "Foundational work in cybernetics, very high density.");

  /* evaluatorReasoning + evaluatorModel — из result, НЕ из evaluation */
  assert.match(updated.evaluatorReasoning ?? "", /foundational characteristics/);
  assert.equal(updated.evaluatorModel, "qwen3-4b");

  /* Status terminal для evaluator. */
  assert.equal(updated.status, "evaluated");
  assert.equal(updated.evaluatedAt, "2026-05-10T12:00:00.000Z");
});

test("[evaluator-mapping] buildEvaluatedMeta: baseMeta поля сохраняются (id, sha256, mdPath)", () => {
  const baseMeta = makeBaseMeta({
    id: "preserved-id",
    sha256: "b".repeat(64),
    originalFile: "preserved.pdf",
    mdPath: "/library/preserved.md",
    wordCount: 5000,
  });
  const updated = buildEvaluatedMeta({
    baseMeta,
    result: makeResult(makeEvaluation()),
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  assert.equal(updated.id, "preserved-id", "id immutable");
  assert.equal(updated.sha256, "b".repeat(64));
  assert.equal(updated.originalFile, "preserved.pdf");
  assert.equal(updated.mdPath, "/library/preserved.md");
  assert.equal(updated.wordCount, 5000);
});

/* ─── year fallback ───────────────────────────────────────────────── */

test("[evaluator-mapping] buildEvaluatedMeta: year=null → fallback на baseMeta.year", () => {
  const baseMeta = makeBaseMeta({ year: 2010 });
  const ev = makeEvaluation({ year: null });
  const updated = buildEvaluatedMeta({
    baseMeta,
    result: makeResult(ev),
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  assert.equal(updated.year, 2010, "fallback to baseMeta.year when evaluation.year is null");
});

test("[evaluator-mapping] buildEvaluatedMeta: year=null + baseMeta.year=undefined → undefined", () => {
  const baseMeta = makeBaseMeta({ year: undefined });
  const ev = makeEvaluation({ year: null });
  const updated = buildEvaluatedMeta({
    baseMeta,
    result: makeResult(ev),
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  assert.equal(updated.year, undefined);
});

test("[evaluator-mapping] buildEvaluatedMeta: evaluation.year overrides baseMeta.year", () => {
  const baseMeta = makeBaseMeta({ year: 2010 });
  const ev = makeEvaluation({ year: 1948 });
  const updated = buildEvaluatedMeta({
    baseMeta,
    result: makeResult(ev),
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  assert.equal(updated.year, 1948, "evaluation.year wins when present");
});

/* ─── Warnings merging ────────────────────────────────────────────── */

test("[evaluator-mapping] buildEvaluatedMeta: empty warnings → keep baseMeta.warnings (no allocation)", () => {
  const baseMeta = makeBaseMeta({ warnings: ["prev warning 1"] });
  const result = makeResult(makeEvaluation(), { warnings: [] });
  const updated = buildEvaluatedMeta({
    baseMeta,
    result,
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  /* Семантика: пустые новые warnings не должны создавать новый массив. */
  assert.deepEqual(updated.warnings, ["prev warning 1"]);
});

test("[evaluator-mapping] buildEvaluatedMeta: new warnings appended to baseMeta.warnings", () => {
  const baseMeta = makeBaseMeta({ warnings: ["prev"] });
  const result = makeResult(makeEvaluation(), { warnings: ["new1", "new2"] });
  const updated = buildEvaluatedMeta({
    baseMeta,
    result,
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  assert.deepEqual(updated.warnings, ["prev", "new1", "new2"]);
});

test("[evaluator-mapping] buildEvaluatedMeta: baseMeta без warnings + новые warnings → just new", () => {
  const baseMeta = makeBaseMeta({ warnings: undefined });
  const result = makeResult(makeEvaluation(), { warnings: ["new"] });
  const updated = buildEvaluatedMeta({
    baseMeta,
    result,
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  assert.deepEqual(updated.warnings, ["new"]);
});

/* ─── reasoning fallback ──────────────────────────────────────────── */

test("[evaluator-mapping] buildEvaluatedMeta: result.reasoning=null → evaluatorReasoning=undefined", () => {
  const result = makeResult(makeEvaluation(), { reasoning: null });
  const updated = buildEvaluatedMeta({
    baseMeta: makeBaseMeta(),
    result,
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  assert.equal(updated.evaluatorReasoning, undefined);
});

/* ─── Guard: null evaluation throws ───────────────────────────────── */

test("[evaluator-mapping] buildEvaluatedMeta: null evaluation → throws (caller must guard)", () => {
  assert.throws(
    () => buildEvaluatedMeta({
      baseMeta: makeBaseMeta(),
      result: makeResult(null), /* null evaluation */
      evaluatedAt: "2026-05-10T12:00:00.000Z",
    }),
    /must not be null/,
  );
});

/* ─── is_fiction_or_water true/false ──────────────────────────────── */

test("[evaluator-mapping] buildEvaluatedMeta: is_fiction_or_water=true preserved", () => {
  const ev = makeEvaluation({ is_fiction_or_water: true, quality_score: 15 });
  const updated = buildEvaluatedMeta({
    baseMeta: makeBaseMeta(),
    result: makeResult(ev),
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  assert.equal(updated.isFictionOrWater, true);
  assert.equal(updated.qualityScore, 15);
});

/* ─── buildEvaluatorDoneEvent ─────────────────────────────────────── */

test("[evaluator-mapping] buildEvaluatorDoneEvent: full payload", () => {
  const ev = makeEvaluation({ quality_score: 75, title_en: "Test Book", is_fiction_or_water: false });
  const result = makeResult(ev, { warnings: ["minor issue"] });
  const event = buildEvaluatorDoneEvent("book-123", result);
  assert.equal(event.type, "evaluator.done");
  assert.equal(event.bookId, "book-123");
  assert.equal(event.title, "Test Book");
  assert.equal(event.qualityScore, 75);
  assert.equal(event.isFictionOrWater, false);
  assert.deepEqual(event.warnings, ["minor issue"]);
});

test("[evaluator-mapping] buildEvaluatorDoneEvent: empty warnings → warnings=undefined", () => {
  const event = buildEvaluatorDoneEvent("b", makeResult(makeEvaluation(), { warnings: [] }));
  assert.equal(event.warnings, undefined, "empty array suppressed to undefined");
});

test("[evaluator-mapping] buildEvaluatorDoneEvent: null evaluation → throws", () => {
  assert.throws(
    () => buildEvaluatorDoneEvent("b", makeResult(null)),
    /must not be null/,
  );
});

/* ─── Cross-contract: meta + event агрегируют те же поля ─────────── */

test("[evaluator-mapping] cross-contract: meta.qualityScore == event.qualityScore", () => {
  /* Защита от рассинхрона: если кто-то поменял quality_score → meta,
     но забыл синхронизировать event'а — этот тест поймает. */
  const ev = makeEvaluation({ quality_score: 42, is_fiction_or_water: true });
  const result = makeResult(ev);
  const meta = buildEvaluatedMeta({
    baseMeta: makeBaseMeta(),
    result,
    evaluatedAt: "2026-05-10T12:00:00.000Z",
  });
  const event = buildEvaluatorDoneEvent("b", result);
  assert.equal(meta.qualityScore, event.qualityScore);
  assert.equal(meta.isFictionOrWater, event.isFictionOrWater);
});
