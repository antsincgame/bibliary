/**
 * Генератор JSON Schema для structured output LM Studio.
 *
 * Возвращает payload, готовый для подстановки в `response_format`
 * (LM Studio 0.4.0+, OpenAI-совместимый):
 *   response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }
 *
 * Источник истины для domains/length-limits — `data/prompts/mechanicus-grammar.json`,
 * читаемый через PromptStore. Если grammar недоступен — fallback на минимальные дефолты.
 */
import type { MechanicusGrammar } from "../prompts/store";

export interface MechanicusJsonSchema {
  type: "object";
  required: string[];
  additionalProperties: false;
  properties: {
    principle: { type: "string"; minLength: number; maxLength: number };
    explanation: { type: "string"; minLength: number; maxLength: number };
    domain: { type: "string"; enum: string[] };
    tags: {
      type: "array";
      minItems: number;
      maxItems: number;
      items: { type: "string"; minLength: number; maxLength: number; pattern: string };
    };
  };
}

export interface ResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    strict: true;
    schema: MechanicusJsonSchema;
  };
}

const FALLBACK_DOMAINS = [
  "ui",
  "web",
  "mobile",
  "ux",
  "perf",
  "arch",
  "copy",
  "seo",
  "research",
];

const KEBAB_PATTERN = "^[a-z0-9]+(-[a-z0-9]+)*$";

export function buildMechanicusSchema(grammar?: MechanicusGrammar | null): MechanicusJsonSchema {
  const domains = grammar?.domains ?? FALLBACK_DOMAINS;
  const principleMin = grammar?.principle.minLength ?? 3;
  const principleMax = grammar?.principle.maxLength ?? 300;
  const explanationMin = grammar?.explanation.minLength ?? 10;
  const explanationMax = grammar?.explanation.maxLength ?? 2000;

  return {
    type: "object",
    required: ["principle", "explanation", "domain", "tags"],
    additionalProperties: false,
    properties: {
      principle: { type: "string", minLength: principleMin, maxLength: principleMax },
      explanation: { type: "string", minLength: explanationMin, maxLength: explanationMax },
      domain: { type: "string", enum: [...domains] },
      tags: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 50, pattern: KEBAB_PATTERN },
      },
    },
  };
}

export function buildMechanicusResponseFormat(
  grammar?: MechanicusGrammar | null,
  schemaName = "mechanicus_chunk"
): ResponseFormat {
  return {
    type: "json_schema",
    json_schema: {
      name: schemaName,
      strict: true,
      schema: buildMechanicusSchema(grammar),
    },
  };
}
