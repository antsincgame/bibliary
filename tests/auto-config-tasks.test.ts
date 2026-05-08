/**
 * Тесты эвристического autoConfigureTasks — распределяет loaded модели по
 * reader/extractor/vision-ocr на основе vision capability, reasoning markers
 * и размера в B-параметрах.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  autoConfigureTasks,
  toPreferenceUpdates,
  estimateModelVramGb,
  totalVramEstimateGb,
} from "../electron/lib/llm/auto-config.ts";
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

/* ── VRAM estimator ─────────────────────────────────────────────────── */

test("[vram-estimate] 14B Q4 ≈ 8.4 GB (14×0.5×1.2 = 8.4)", () => {
  const est = estimateModelVramGb(model("qwen3-14b-thinking", { quantization: "Q4_K_M" }));
  assert.equal(est, 8.4);
});

test("[vram-estimate] 7B F16 ≈ 16.8 GB (7×2×1.2)", () => {
  const est = estimateModelVramGb(model("qwen2.5-7b", { quantization: "F16" }));
  assert.equal(est, 16.8);
});

test("[vram-estimate] 3B Q8 ≈ 3.6 GB (3×1×1.2)", () => {
  const est = estimateModelVramGb(model("qwen2.5-3b-instruct", { quantization: "Q8_0" }));
  assert.equal(est, 3.6);
});

test("[vram-estimate] no params in name → null", () => {
  const est = estimateModelVramGb(model("custom-model-no-params"));
  assert.equal(est, null);
});

test("[vram-estimate] no quantization → assume Q4 (0.5 byte/param)", () => {
  const est = estimateModelVramGb(model("qwen2.5-7b"));
  assert.equal(est, 4.2);
});

test("[total-vram] sum of 3 unique models", () => {
  const loaded = [
    model("qwen2.5-3b-instruct", { quantization: "Q4_K_M" }),       /* 1.8 */
    model("qwen3-14b-thinking", { quantization: "Q4_K_M" }),        /* 8.4 */
    model("qwen2.5-vl-7b", { vision: true, quantization: "Q4_K_M" }),/* 4.2 */
  ];
  const result = autoConfigureTasks(loaded);
  const total = totalVramEstimateGb(result, loaded);
  /* 1.8 + 8.4 + 4.2 = 14.4 */
  assert.equal(total, 14.4);
});

test("[total-vram] дубль modelKey не считается дважды (1 модель на 2 задачи)", () => {
  const m = model("qwen-vl-7b", { vision: true, quantization: "Q4_K_M" });
  const result = autoConfigureTasks([m]);
  /* Single model → extractor И vision-ocr оба = qwen-vl-7b. */
  const total = totalVramEstimateGb(result, [m]);
  /* 7×0.5×1.2 = 4.2, посчитан один раз. */
  assert.equal(total, 4.2);
});
