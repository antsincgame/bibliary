import type { ResponseFormatPayload } from "../../dataset-v2/json-schemas.js";

export type ResponseFormatStrategy = "json_schema" | "text";

export interface PickResponseFormatOptions {
  modelKey: string;
  schemaBuilder: () => ResponseFormatPayload;
  forceText?: boolean;
}

const THINKING_MARKERS: ReadonlyArray<string> = [
  "qwen3.5",
  "qwen3.6",
  "qwen3-thinking",
  "deepseek-r1",
  "deepseek-v3",
  "magistral",
  "reasoning",
  "thinking",
  "qwq",
  "o1-",
  "/r1",
];

export function isThinkingModel(modelKey: string): boolean {
  if (!modelKey) return false;
  const lc = modelKey.toLowerCase();
  return THINKING_MARKERS.some((m) => lc.includes(m));
}

export function pickResponseFormat(opts: PickResponseFormatOptions): {
  strategy: ResponseFormatStrategy;
  payload: ResponseFormatPayload;
} {
  if (opts.forceText === true || isThinkingModel(opts.modelKey)) {
    return { strategy: "text", payload: { type: "text" } };
  }
  return { strategy: "json_schema", payload: opts.schemaBuilder() };
}
