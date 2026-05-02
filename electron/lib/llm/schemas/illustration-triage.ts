import type { ResponseFormatPayload } from "../../dataset-v2/json-schemas.js";

export function buildIllustrationTriageResponseFormat(): ResponseFormatPayload {
  return {
    type: "json_schema",
    json_schema: {
      name: "illustration_triage",
      strict: true,
      schema: {
        type: "object",
        required: ["score", "description"],
        additionalProperties: false,
        properties: {
          score: {
            type: "integer",
            minimum: 0,
            maximum: 10,
          },
          description: {
            type: "string",
            maxLength: 600,
          },
        },
      },
    },
  };
}
