/**
 * JSON Schema builders для constrained output LM Studio (response_format).
 *
 * Существуют отдельно от gbnf-mechanicus.ts потому что:
 *   - Mechanicus генерирует ОДИН концепт без noveltyHint/sourceQuote
 *   - dataset-v2 extractor генерирует МАССИВ концептов с novelty + quote
 *   - dataset-v2 judge генерирует один JudgeResult с тремя осями
 *
 * Все схемы синхронизированы с Zod-схемами из types.ts (ExtractedConceptSchema,
 * JudgeResultSchema). При изменении Zod — обновлять и эти билдеры.
 */

/**
 * Возвращаем Record<string, unknown> а не строгий тип, чтобы payload
 * можно было передать в ChatRequest.responseFormat без cast'а.
 * Структура соответствует OpenAI / LM Studio response_format спецификации.
 */
export type ResponseFormatPayload = Record<string, unknown>;

/**
 * Schema для concept-extractor: ARRAY of ExtractedConcept (max 8 items).
 * Соответствует ExtractedConceptArraySchema в types.ts.
 *
 * Передаётся в LM Studio через response_format. После успешного decoding
 * модель ОБЯЗАНА вернуть JSON-массив, валидный по этой схеме (constrained).
 *
 * Длины (min/max chars) совпадают с Zod, чтобы не отбрасывать валидный
 * по схеме output на per-item Zod check.
 */
export function buildExtractorResponseFormat(allowedDomains: string[]): ResponseFormatPayload {
  return {
    type: "json_schema",
    json_schema: {
      name: "concept_array",
      strict: true,
      schema: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          required: ["principle", "explanation", "domain", "tags", "noveltyHint", "sourceQuote"],
          additionalProperties: false,
          properties: {
            principle: { type: "string", minLength: 20, maxLength: 400 },
            explanation: { type: "string", minLength: 80, maxLength: 1500 },
            domain: { type: "string", enum: [...allowedDomains] },
            tags: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: { type: "string", minLength: 1, maxLength: 40 },
            },
            noveltyHint: { type: "string", minLength: 10, maxLength: 300 },
            sourceQuote: { type: "string", minLength: 10, maxLength: 800 },
          },
        },
      },
    },
  };
}

/**
 * Schema для judge: один JudgeResult с тремя осями + reasoning.
 * Соответствует JudgeResultSchema в types.ts.
 */
export function buildJudgeResponseFormat(): ResponseFormatPayload {
  return {
    type: "json_schema",
    json_schema: {
      name: "judge_result",
      strict: true,
      schema: {
        type: "object",
        required: ["novelty", "actionability", "domain_fit", "reasoning"],
        additionalProperties: false,
        properties: {
          novelty: { type: "number", minimum: 0, maximum: 1 },
          actionability: { type: "number", minimum: 0, maximum: 1 },
          domain_fit: { type: "number", minimum: 0, maximum: 1 },
          reasoning: { type: "string", minLength: 10, maxLength: 800 },
        },
      },
    },
  };
}
