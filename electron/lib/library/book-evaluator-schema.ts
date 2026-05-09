/**
 * Schema, response-format и парсинг для Book Evaluator.
 *
 * Извлечено из `book-evaluator.ts` (Phase 2.3 cross-platform roadmap, 2026-04-30).
 * Чистые функции — никакого I/O, нет зависимости от LM Studio. Это позволяет
 * unit-тестировать парсинг отдельно от LLM.
 */

import { z } from "zod";
import { parseReasoningResponse } from "./reasoning-parser.js";
import { extractJsonObjectFromReasoning } from "../dataset-v2/reasoning-decoder.js";

/* Zod-схема для валидации JSON ответа эвалюатора. */
export const evaluationSchema = z.object({
  title_ru: z.string().min(1),
  author_ru: z.string().min(1),
  title_en: z.string().min(1),
  author_en: z.string().min(1),
  year: z.number().int().min(1400).max(2100).nullable(),
  domain: z.string().min(1),
  tags: z.array(z.string()).min(8).max(12),
  tags_ru: z.array(z.string()).min(8).max(12),
  is_fiction_or_water: z.boolean(),
  conceptual_density: z.number().int().min(0).max(100),
  originality: z.number().int().min(0).max(100),
  quality_score: z.number().int().min(0).max(100),
  /* >= 30 chars per .claude/rules/03-evaluation.md "1. Оценка ВСЕГДА с
   * reasoning ≥30 chars" — голая короткая фраза («ok», «bad», «good»)
   * не несёт сигнала для downstream и не должна проходить валидацию. */
  verdict_reason: z.string().min(30),
});

export function buildEvaluatorResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "book_evaluation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "title_ru",
          "author_ru",
          "title_en",
          "author_en",
          "year",
          "domain",
          "tags",
          "tags_ru",
          "is_fiction_or_water",
          "conceptual_density",
          "originality",
          "quality_score",
          "verdict_reason",
        ],
        properties: {
          title_ru: { type: "string", minLength: 1 },
          author_ru: { type: "string", minLength: 1 },
          title_en: { type: "string", minLength: 1 },
          author_en: { type: "string", minLength: 1 },
          year: { anyOf: [{ type: "integer", minimum: 1400, maximum: 2100 }, { type: "null" }] },
          domain: { type: "string", minLength: 1 },
          tags: {
            type: "array",
            minItems: 8,
            maxItems: 12,
            items: { type: "string", minLength: 1 },
          },
          tags_ru: {
            type: "array",
            minItems: 8,
            maxItems: 12,
            items: { type: "string", minLength: 1 },
          },
          is_fiction_or_water: { type: "boolean" },
          conceptual_density: { type: "integer", minimum: 0, maximum: 100 },
          originality: { type: "integer", minimum: 0, maximum: 100 },
          quality_score: { type: "integer", minimum: 0, maximum: 100 },
          verdict_reason: { type: "string", minLength: 30 },
        },
      },
    },
  };
}

export function parseEvaluationResponse(
  raw: string,
  reasoningFromApi: string | undefined,
): { json: unknown | null; reasoning: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const parsed = parseReasoningResponse<unknown>(raw);
  warnings.push(...parsed.warnings);

  let reasoning = parsed.reasoning;
  if ((!reasoning || reasoning.length === 0) && reasoningFromApi && reasoningFromApi.length > 0) {
    reasoning = reasoningFromApi.trim();
  }

  if (parsed.json !== null) {
    return { json: parsed.json, reasoning, warnings };
  }

  const recovered = extractJsonObjectFromReasoning(reasoningFromApi);
  if (recovered) {
    try {
      warnings.push("evaluator: recovered JSON object from reasoning_content");
      return { json: JSON.parse(recovered), reasoning, warnings };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`evaluator: reasoning_content JSON.parse failed: ${msg}`);
    }
  }

  return { json: null, reasoning, warnings };
}

export function isLmStudioBadRequest(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /LM Studio HTTP 400/i.test(msg);
}
