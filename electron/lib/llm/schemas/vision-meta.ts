import type { ResponseFormatPayload } from "../../dataset-v2/json-schemas.js";

export function buildVisionMetaResponseFormat(): ResponseFormatPayload {
  return {
    type: "json_schema",
    json_schema: {
      name: "vision_meta",
      strict: true,
      schema: {
        type: "object",
        required: ["title", "author", "authors", "year", "language", "publisher", "confidence"],
        additionalProperties: false,
        properties: {
          title: { type: ["string", "null"] },
          author: { type: ["string", "null"] },
          authors: {
            type: "array",
            items: { type: "string" },
            maxItems: 32,
          },
          year: {
            type: ["integer", "null"],
            minimum: 1400,
            maximum: 2100,
          },
          language: {
            type: ["string", "null"],
            minLength: 2,
            maxLength: 10,
          },
          publisher: { type: ["string", "null"] },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
        },
      },
    },
  };
}
