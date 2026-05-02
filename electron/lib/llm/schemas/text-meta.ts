import type { ResponseFormatPayload } from "../../dataset-v2/json-schemas.js";

export function buildTextMetaResponseFormat(): ResponseFormatPayload {
  return {
    type: "json_schema",
    json_schema: {
      name: "text_meta",
      strict: true,
      schema: {
        type: "object",
        required: ["title", "author", "year", "language", "publisher"],
        additionalProperties: false,
        properties: {
          title: { type: ["string", "null"], maxLength: 500 },
          author: { type: ["string", "null"], maxLength: 300 },
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
          publisher: { type: ["string", "null"], maxLength: 200 },
        },
      },
    },
  };
}
