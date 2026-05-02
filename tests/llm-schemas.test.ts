import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isThinkingModel,
  pickResponseFormat,
} from "../electron/lib/llm/schemas/utils.ts";
import { buildVisionMetaResponseFormat } from "../electron/lib/llm/schemas/vision-meta.ts";
import { buildTextMetaResponseFormat } from "../electron/lib/llm/schemas/text-meta.ts";
import { buildIllustrationTriageResponseFormat } from "../electron/lib/llm/schemas/illustration-triage.ts";

test("isThinkingModel: detects qwen3.5/3.6/thinking/reasoning markers", () => {
  assert.equal(isThinkingModel("qwen/qwen3.5-9b"), true);
  assert.equal(isThinkingModel("qwen/qwen3.6-35b-a3b"), true);
  assert.equal(isThinkingModel("deepseek-r1-distill-qwen-7b"), true);
  assert.equal(isThinkingModel("magistral-small"), true);
  assert.equal(isThinkingModel("qwq-32b-preview"), true);
  assert.equal(isThinkingModel("o1-mini"), true);
});

test("isThinkingModel: rejects regular instruct/coder models", () => {
  assert.equal(isThinkingModel("qwen/qwen3-4b-2507"), false);
  assert.equal(isThinkingModel("qwen2.5-coder-32b-instruct"), false);
  assert.equal(isThinkingModel("mistral-small-3.1-24b-instruct-2503-hf"), false);
  assert.equal(isThinkingModel("google/gemma-3-4b-it"), false);
  assert.equal(isThinkingModel(""), false);
});

test("pickResponseFormat: returns json_schema for non-thinking models", () => {
  const result = pickResponseFormat({
    modelKey: "qwen/qwen3-4b-2507",
    schemaBuilder: buildTextMetaResponseFormat,
  });
  assert.equal(result.strategy, "json_schema");
  assert.equal(result.payload.type, "json_schema");
  assert.ok(typeof result.payload.json_schema === "object");
});

test("pickResponseFormat: returns text for thinking models (LM Studio bug #1773 mitigation)", () => {
  const result = pickResponseFormat({
    modelKey: "qwen/qwen3.6-35b-a3b",
    schemaBuilder: buildVisionMetaResponseFormat,
  });
  assert.equal(result.strategy, "text");
  assert.deepEqual(result.payload, { type: "text" });
});

test("pickResponseFormat: forceText overrides model detection", () => {
  const result = pickResponseFormat({
    modelKey: "google/gemma-3-4b-it",
    schemaBuilder: buildTextMetaResponseFormat,
    forceText: true,
  });
  assert.equal(result.strategy, "text");
  assert.deepEqual(result.payload, { type: "text" });
});

test("buildVisionMetaResponseFormat: contract — required fields, ranges, types", () => {
  const rf = buildVisionMetaResponseFormat();
  assert.equal(rf.type, "json_schema");
  const schema = rf.json_schema as { name: string; strict: boolean; schema: Record<string, unknown> };
  assert.equal(schema.name, "vision_meta");
  assert.equal(schema.strict, true);
  const fields = schema.schema as { required: string[]; properties: Record<string, { type: string | string[] }> };
  assert.deepEqual(
    [...fields.required].sort(),
    ["author", "authors", "confidence", "language", "publisher", "title", "year"],
  );
  assert.deepEqual(fields.properties.title!.type, ["string", "null"]);
  assert.deepEqual(fields.properties.year!.type, ["integer", "null"]);
});

test("buildTextMetaResponseFormat: contract — required fields", () => {
  const rf = buildTextMetaResponseFormat();
  const schema = rf.json_schema as { name: string; schema: { required: string[] } };
  assert.equal(schema.name, "text_meta");
  assert.deepEqual([...schema.schema.required].sort(), ["author", "language", "publisher", "title", "year"]);
});

test("buildIllustrationTriageResponseFormat: score is integer 0-10", () => {
  const rf = buildIllustrationTriageResponseFormat();
  const schema = rf.json_schema as {
    schema: { properties: { score: { type: string; minimum: number; maximum: number } } };
  };
  assert.equal(schema.schema.properties.score.type, "integer");
  assert.equal(schema.schema.properties.score.minimum, 0);
  assert.equal(schema.schema.properties.score.maximum, 10);
});

test("response_format builders: never produce deprecated json_object (regression for LM Studio HTTP 400)", () => {
  for (const builder of [
    buildVisionMetaResponseFormat,
    buildTextMetaResponseFormat,
    buildIllustrationTriageResponseFormat,
  ]) {
    const rf = builder();
    assert.notEqual(rf.type, "json_object", `${builder.name} must NOT emit json_object`);
    assert.equal(rf.type, "json_schema");
  }
});
