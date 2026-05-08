/**
 * Тесты эвристического autoConfigureTasks — распределяет loaded модели по
 * reader/extractor/vision-ocr на основе vision capability, reasoning markers
 * и размера в B-параметрах.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { autoConfigureTasks, toPreferenceUpdates } from "../electron/lib/llm/auto-config.ts";
import type { LoadedModelInfo } from "../electron/lmstudio-client.ts";

function model(modelKey: string, overrides: Partial<LoadedModelInfo> = {}): LoadedModelInfo {
  return {
    identifier: modelKey,
    modelKey,
    ...overrides,
  };
}

test("[auto-config] empty list — все null + 3 reasons", () => {
  const result = autoConfigureTasks([]);
  assert.equal(result.assignments.reader, null);
  assert.equal(result.assignments.extractor, null);
  assert.equal(result.assignments["vision-ocr"], null);
  assert.equal(result.reasons.length, 3);
  assert.ok(result.reasons.every((r) => r.modelKey === null));
});

test("[auto-config] одна модель → extractor (most important task)", () => {
  const result = autoConfigureTasks([model("qwen2.5-7b-instruct")]);
  assert.equal(result.assignments.extractor, "qwen2.5-7b-instruct");
  assert.equal(result.assignments.reader, null);
  assert.equal(result.assignments["vision-ocr"], null);
});

test("[auto-config] одна vision модель → vision-ocr И extractor", () => {
  const result = autoConfigureTasks([model("qwen2.5-vl-7b", { vision: true })]);
  assert.equal(result.assignments.extractor, "qwen2.5-vl-7b");
  assert.equal(result.assignments["vision-ocr"], "qwen2.5-vl-7b");
});

test("[auto-config] классический сценарий: 3B + 14B reasoning + VL → каждый на своё место", () => {
  const result = autoConfigureTasks([
    model("qwen2.5-3b-instruct"),
    model("qwen3-14b-thinking"),
    model("qwen2.5-vl-7b", { vision: true }),
  ]);
  assert.equal(result.assignments.reader, "qwen2.5-3b-instruct");
  assert.equal(result.assignments.extractor, "qwen3-14b-thinking");
  assert.equal(result.assignments["vision-ocr"], "qwen2.5-vl-7b");
});

test("[auto-config] reasoning приоритетнее размера (8B-r1 > 14B-instruct)", () => {
  const result = autoConfigureTasks([
    model("llama-3-8b-deepseek-r1"),
    model("mistral-14b-instruct"),
  ]);
  assert.equal(result.assignments.extractor, "llama-3-8b-deepseek-r1",
    "r1 reasoning marker должен победить size");
});

test("[auto-config] нет vision-моделей → vision-ocr = null с пояснением", () => {
  const result = autoConfigureTasks([
    model("qwen2.5-3b-instruct"),
    model("qwen3-14b-thinking"),
  ]);
  assert.equal(result.assignments["vision-ocr"], null);
  const visionReason = result.reasons.find((r) => r.task === "vision-ocr");
  assert.ok(visionReason);
  assert.match(visionReason!.reason, /no vision-capable/i);
});

test("[auto-config] две reasoning модели → берём большую", () => {
  const result = autoConfigureTasks([
    model("qwen3-7b-thinking"),
    model("qwen3-32b-thinking"),
  ]);
  assert.equal(result.assignments.extractor, "qwen3-32b-thinking");
});

test("[auto-config] только большие нон-reasoning → берём largest для extractor, нет fallback для reader", () => {
  const result = autoConfigureTasks([
    model("llama-3-70b-instruct"),
    model("mistral-large-2-instruct"),
  ]);
  /* 70B побеждает по размеру */
  assert.equal(result.assignments.extractor, "llama-3-70b-instruct");
  /* Reader fallback на оставшуюся text-модель */
  assert.equal(result.assignments.reader, "mistral-large-2-instruct");
});

test("[auto-config] две vision модели → больший выигрывает для vision-ocr", () => {
  const result = autoConfigureTasks([
    model("qwen2.5-vl-3b", { vision: true }),
    model("qwen2.5-vl-72b", { vision: true }),
  ]);
  assert.equal(result.assignments["vision-ocr"], "qwen2.5-vl-72b");
});

test("[auto-config] только vision модели → reader/extractor = null с пояснением", () => {
  const result = autoConfigureTasks([
    model("qwen2.5-vl-7b", { vision: true }),
    model("llava-1.5-13b", { vision: true }),
  ]);
  /* 13B-vision выигрывает (72B нет, 13B>7B). */
  assert.equal(result.assignments["vision-ocr"], "llava-1.5-13b");
  assert.equal(result.assignments.reader, null);
  assert.equal(result.assignments.extractor, null);
});

test("[auto-config] mini/flash markers → reader candidate", () => {
  const result = autoConfigureTasks([
    model("phi-3-mini-instruct"),
    model("qwen3-14b-instruct"),
  ]);
  assert.equal(result.assignments.reader, "phi-3-mini-instruct",
    "mini маркер должен сделать модель reader-кандидатом");
  assert.equal(result.assignments.extractor, "qwen3-14b-instruct");
});

test("[auto-config] reasons непустые и содержат task/modelKey", () => {
  const result = autoConfigureTasks([
    model("qwen2.5-3b-instruct"),
    model("qwen3-14b-thinking"),
  ]);
  assert.equal(result.reasons.length, 3);
  for (const r of result.reasons) {
    assert.ok(r.task);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  }
});

test("[auto-config] toPreferenceUpdates: только non-null поля", () => {
  const result = autoConfigureTasks([
    model("qwen2.5-3b-instruct"),
    model("qwen3-14b-thinking"),
    /* vision-ocr остаётся null */
  ]);
  const updates = toPreferenceUpdates(result);
  assert.equal(updates.readerModel, "qwen2.5-3b-instruct");
  assert.equal(updates.extractorModel, "qwen3-14b-thinking");
  assert.ok(!("visionOcrModel" in updates), "null vision-ocr не должен попадать в updates");
});

test("[auto-config] B-параметры с дробью (1.5b) парсятся", () => {
  const result = autoConfigureTasks([
    model("qwen2.5-1.5b"),
    model("qwen2.5-7b"),
  ]);
  /* 1.5b — small/fast маркер (<=7), идёт на reader. */
  assert.equal(result.assignments.reader, "qwen2.5-1.5b");
  assert.equal(result.assignments.extractor, "qwen2.5-7b");
});
