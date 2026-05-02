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

test("[Д.1] aggregateVisionRoles: best_avg выбирает модель с лучшим средним по 3 ролям", () => {
  /* model-A: avg по ролям = (0.9 + 0.8 + 0.7) / 3 = 0.8
     model-B: avg = (0.6 + 0.7 + 0.8) / 3 = 0.7
     model-C: avg = (0.85 + 0.85 + 0.65) / 3 = ~0.78
     Победитель = A. */
  const aggs: OlympicsRoleAggregate[] = [
    makeAgg("vision_meta", [
      { model: "model-A", avgScore: 0.9 },
      { model: "model-B", avgScore: 0.6 },
      { model: "model-C", avgScore: 0.85 },
    ]),
    makeAgg("vision_ocr", [
      { model: "model-A", avgScore: 0.8 },
      { model: "model-B", avgScore: 0.7 },
      { model: "model-C", avgScore: 0.85 },
    ]),
    makeAgg("vision_illustration", [
      { model: "model-A", avgScore: 0.7 },
      { model: "model-B", avgScore: 0.8 },
      { model: "model-C", avgScore: 0.65 },
    ]),
  ];

  const result = aggregateVisionRoles(aggs);
  assert.ok(result, "должна вернуться рекомендация");
  assert.equal(result.modelKey, "model-A", "model-A best_avg = 0.8");
  assert.equal(result.strategy, "best_avg");
  assert.match(result.reason, /3 vision-roles/);
});

test("[Д.1] aggregateVisionRoles: tie на avg → побеждает min (стабильность)", () => {
  /* model-X: avg = (0.8 + 0.8 + 0.8) / 3 = 0.8, min = 0.8
     model-Y: avg = (1.0 + 0.7 + 0.7) / 3 = 0.8, min = 0.7
     При одинаковом avg X побеждает по min. */
  const aggs: OlympicsRoleAggregate[] = [
    makeAgg("vision_meta", [
      { model: "model-X", avgScore: 0.8 },
      { model: "model-Y", avgScore: 1.0 },
    ]),
    makeAgg("vision_ocr", [
      { model: "model-X", avgScore: 0.8 },
      { model: "model-Y", avgScore: 0.7 },
    ]),
    makeAgg("vision_illustration", [
      { model: "model-X", avgScore: 0.8 },
      { model: "model-Y", avgScore: 0.7 },
    ]),
  ];

  const result = aggregateVisionRoles(aggs);
  assert.ok(result);
  assert.equal(result.modelKey, "model-X", "tie → min wins → X (более стабильная)");
});

test("[Д.1] aggregateVisionRoles: fallback last-write если ни одна модель не прошла все роли", () => {
  /* model-A прошла vision_meta (okCount=2/2) и vision_ocr (1/1), но НЕ vision_illustration (okCount=0/1).
     model-B прошла только vision_illustration.
     Никто не покрыл все 3 → fallback. Берём optimum последней vision-роли (vision_illustration → B). */
  const aggs: OlympicsRoleAggregate[] = [
    makeAgg("vision_meta", [
      { model: "model-A", avgScore: 0.9, okCount: 2, totalCount: 2 },
    ]),
    makeAgg("vision_ocr", [
      { model: "model-A", avgScore: 0.8, okCount: 1, totalCount: 1 },
    ]),
    makeAgg("vision_illustration", [
      { model: "model-A", avgScore: 0.5, okCount: 0, totalCount: 1 },
      { model: "model-B", avgScore: 0.7, okCount: 1, totalCount: 1 },
    ]),
  ];
  /* Перезапишем optimum последней роли (имитация что buildRoleAggregates выбрал B) */
  aggs[2].optimum = "model-B";

  const result = aggregateVisionRoles(aggs);
  assert.ok(result);
  assert.equal(result.strategy, "fallback_last_write");
  assert.equal(result.modelKey, "model-B");
  assert.match(result.reason, /fallback/);
});

test("[Д.1] aggregateVisionRoles: single-model edge — она же и победитель", () => {
  const aggs: OlympicsRoleAggregate[] = [
    makeAgg("vision_meta", [{ model: "only-model", avgScore: 0.5 }]),
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
