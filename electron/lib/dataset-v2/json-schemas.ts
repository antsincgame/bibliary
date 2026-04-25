/**
 * JSON Schema builders for constrained output LM Studio (response_format).
 *
 * Synced with DeltaKnowledgeSchema in types.ts. When Zod changes — update here too.
 */

export type ResponseFormatPayload = Record<string, unknown>;

export function buildDeltaKnowledgeResponseFormat(allowedDomains: string[]): ResponseFormatPayload {
  return {
    type: "json_schema",
    json_schema: {
      name: "delta_knowledge",
      strict: true,
      schema: {
        type: "object",
        required: ["domain", "chapterContext", "essence", "cipher", "proof", "auraFlags", "tags"],
        additionalProperties: false,
        properties: {
          domain: { type: "string", enum: [...allowedDomains] },
          chapterContext: { type: "string", minLength: 10, maxLength: 300 },
          essence: { type: "string", minLength: 30, maxLength: 800 },
          cipher: { type: "string", minLength: 5, maxLength: 500 },
          proof: { type: "string", minLength: 10, maxLength: 800 },
          applicability: { type: "string", maxLength: 500 },
          auraFlags: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "string",
              enum: ["authorship", "specialization", "revision", "causality"],
            },
          },
          tags: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", minLength: 1, maxLength: 40 },
          },
        },
      },
    },
  };
}
