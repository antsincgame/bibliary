/**
 * Иt 8Д.1 — `aggregateVisionRoles(strategy=best_avg)`.
 *
 * Anti-regression защита от vision-overwriting bug в `olympics.ts`:
 * раньше цикл `for (agg of roleAggregates) recommendations[agg.prefKey] = agg.optimum`
 * перезаписывал visionModelKey трижды (по числу vision-ролей), результат
 * зависел от порядка Map-iteration. Этот тест гарантирует:
 *   1. одна модель прошедшая все vision-роли — выбирается по best_avg;
 *   2. tie-break по min(avgScore) → eff → alphabetical;
 *   3. fallback к last-write если ни одна модель не прошла все vision-роли;
 *   4. single-model edge case;
 *   5. пустой/нерелевантный input → null.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateVisionRoles } from "../electron/lib/llm/arena/scoring.ts";
import type { OlympicsRoleAggregate } from "../electron/lib/llm/arena/olympics-types.ts";

function makeAgg(
  role: OlympicsRoleAggregate["role"],
  perModel: Array<{
    model: string;
    avgScore: number;
    okCount?: number;
    totalCount?: number;
    avgEfficiency?: number;
    minScore?: number;
  }>,
): OlympicsRoleAggregate {
  const filled = perModel.map((m) => ({
    model: m.model,
    avgScore: m.avgScore,
    minScore: m.minScore ?? m.avgScore,
    avgDurationMs: 1000,
    avgEfficiency: m.avgEfficiency ?? 5,
    coverage: 1,
    okCount: m.okCount ?? m.totalCount ?? 1,
    totalCount: m.totalCount ?? 1,
  }));
  return {
    role,
    prefKey: "visionModelKey",
    disciplines: [`${role}-test`],
    perModel: filled,
    champion: filled[0]?.model ?? null,
    optimum: filled[0]?.model ?? null,
    championReason: null,
    optimumReason: null,
  };
}

test("[Д.1] aggregateVisionRoles: best_avg выбирает модель с лучшим средним по 2 vision-ролям", () => {
  /* MVP v1.0: 2 vision-роли (vision_ocr + vision_illustration).
     model-A: avg = (0.9 + 0.7) / 2 = 0.80
     model-B: avg = (0.7 + 0.8) / 2 = 0.75
     model-C: avg = (0.65 + 0.65) / 2 = 0.65
     Победитель = A. */
  const aggs: OlympicsRoleAggregate[] = [
    makeAgg("vision_ocr", [
      { model: "model-A", avgScore: 0.9 },
      { model: "model-B", avgScore: 0.7 },
      { model: "model-C", avgScore: 0.65 },
    ]),
    makeAgg("vision_illustration", [
      { model: "model-A", avgScore: 0.7 },
      { model: "model-B", avgScore: 0.8 },
      { model: "model-C", avgScore: 0.65 },
    ]),
  ];

  const result = aggregateVisionRoles(aggs);
  assert.ok(result, "должна вернуться рекомендация");
  assert.equal(result.modelKey, "model-A", "model-A best_avg = 0.80");
  assert.equal(result.strategy, "best_avg");
  assert.match(result.reason, /2 vision-roles/);
});

test("[Д.1] aggregateVisionRoles: tie на avg → побеждает min (стабильность)", () => {
  /* model-X: avg = (0.8 + 0.8) / 2 = 0.8, min = 0.8
     model-Y: avg = (1.0 + 0.6) / 2 = 0.8, min = 0.6
     При одинаковом avg X побеждает по min. */
  const aggs: OlympicsRoleAggregate[] = [
    makeAgg("vision_ocr", [
      { model: "model-X", avgScore: 0.8 },
      { model: "model-Y", avgScore: 1.0 },
    ]),
    makeAgg("vision_illustration", [
      { model: "model-X", avgScore: 0.8 },
      { model: "model-Y", avgScore: 0.6 },
    ]),
  ];

  const result = aggregateVisionRoles(aggs);
  assert.ok(result);
  assert.equal(result.modelKey, "model-X", "tie → min wins → X (более стабильная)");
});

test("[Д.1] aggregateVisionRoles: fallback last-write если ни одна модель не прошла все роли", () => {
  /* model-A прошла vision_ocr, но НЕ vision_illustration (okCount=0/1).
     model-B прошла только vision_illustration.
     Никто не покрыл все 2 → fallback. Берём optimum последней vision-роли. */
  const aggs: OlympicsRoleAggregate[] = [
    makeAgg("vision_ocr", [
      { model: "model-A", avgScore: 0.8, okCount: 1, totalCount: 1 },
    ]),
    makeAgg("vision_illustration", [
      { model: "model-A", avgScore: 0.5, okCount: 0, totalCount: 1 },
      { model: "model-B", avgScore: 0.7, okCount: 1, totalCount: 1 },
    ]),
  ];
  aggs[1].optimum = "model-B";

  const result = aggregateVisionRoles(aggs);
  assert.ok(result);
  assert.equal(result.strategy, "fallback_last_write");
  assert.equal(result.modelKey, "model-B");
  assert.match(result.reason, /fallback/);
});

test("[Д.1] aggregateVisionRoles: single-model edge — она же и победитель", () => {
  const aggs: OlympicsRoleAggregate[] = [
    makeAgg("vision_ocr", [{ model: "only-model", avgScore: 0.55 }]),
    makeAgg("vision_illustration", [{ model: "only-model", avgScore: 0.6 }]),
  ];

  const result = aggregateVisionRoles(aggs);
  assert.ok(result);
  assert.equal(result.modelKey, "only-model");
  assert.equal(result.strategy, "best_avg");
});

test("[Д.1] aggregateVisionRoles: пустой input или нерелевантные роли → null", () => {
  assert.equal(aggregateVisionRoles([]), null, "пустой input = null");

  /* Только не-vision роли — должно вернуть null. */
  const nonVision: OlympicsRoleAggregate[] = [
    {
      role: "evaluator",
      prefKey: "evaluatorModel",
      disciplines: ["evaluator-test"],
      perModel: [{ model: "x", avgScore: 0.9, minScore: 0.9, avgDurationMs: 100, avgEfficiency: 5, coverage: 1, okCount: 1, totalCount: 1 }],
      champion: "x", optimum: "x", championReason: null, optimumReason: null,
    },
  ];
  assert.equal(aggregateVisionRoles(nonVision), null, "только non-vision = null");
});
