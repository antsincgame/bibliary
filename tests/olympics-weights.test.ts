/* Olympics: weight-class classification + optimum vs champion + BT-MLE. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWeight,
  pickModelsForOlympics,
  pickModelsForOlympicsV1,
  type LmsModelInfo,
} from "../electron/lib/llm/arena/olympics.ts";

test("classifyWeight: parses size markers in model names", () => {
  assert.equal(classifyWeight("qwen3-0.6b"), "xs");
  assert.equal(classifyWeight("qwen/qwen3.5-9b"), "m");
  assert.equal(classifyWeight("mistralai/ministral-3-3b"), "s");
  assert.equal(classifyWeight("mamaylm-gemma-3-4b-it-v1.0"), "s");
  assert.equal(classifyWeight("qwen/qwen3-4b-2507"), "s");
  assert.equal(classifyWeight("qwen2.5-coder-7b-instruct"), "m");
  assert.equal(classifyWeight("qwen/qwen2.5-coder-32b"), "xl");
  assert.equal(classifyWeight("google_gemma-4-31b-it"), "xl");
  assert.equal(classifyWeight("mistral-small-3.1-24b-instruct-2503-hf"), "l");
});

test("classifyWeight: returns 'unknown' when no size marker", () => {
  assert.equal(classifyWeight("magistral-small"), "unknown");
  assert.equal(classifyWeight("text-embedding-nomic-embed-text-v1.5"), "unknown");
  assert.equal(classifyWeight("zai-org/glm-4.7-flash"), "unknown");
});

test("pickModelsForOlympics: respects weightClasses filter", () => {
  const all = [
    "qwen3-0.6b",                                    /* xs */
    "qwen/qwen3-4b-2507",                            /* s  */
    "mistralai/ministral-3-3b",                      /* s  */
    "qwen2.5-coder-7b-instruct",                     /* m  */
    "qwen/qwen3.5-9b",                               /* m  */
    "qwen/qwen2.5-coder-32b",                        /* xl */
    "text-embedding-nomic-embed-text-v1.5",          /* embed — фильтруется */
  ];

  const xsOnly = pickModelsForOlympics(all, undefined, 4, ["xs"]);
  assert.deepEqual(xsOnly, ["qwen3-0.6b"]);

  const sOnly = pickModelsForOlympics(all, undefined, 4, ["s"]);
  assert.equal(sOnly.length, 2);
  assert.ok(sOnly.every((m) => classifyWeight(m) === "s"));

  const mOnly = pickModelsForOlympics(all, undefined, 4, ["m"]);
  assert.equal(mOnly.length, 2);
  assert.ok(mOnly.every((m) => classifyWeight(m) === "m"));

  const xs_s = pickModelsForOlympics(all, undefined, 5, ["xs", "s"]);
  assert.equal(xs_s.length, 3);
  assert.ok(!xs_s.some((m) => /embed/i.test(m)), "embedding excluded");
});

test("pickModelsForOlympics: explicit list wins over weightClasses", () => {
  const all = ["qwen3-0.6b", "qwen/qwen3-4b-2507", "qwen/qwen2.5-coder-32b"];
  const picked = pickModelsForOlympics(all, ["qwen/qwen2.5-coder-32b"], 4, ["s"]);
  assert.deepEqual(picked, ["qwen/qwen2.5-coder-32b"]);
});

test("pickModelsForOlympics: family diversification within class", () => {
  /* В классе S есть 4 qwen и 1 mistral — выбираем 2 qwen + 1 mistral, не 4 qwen. */
  const all = [
    "qwen/qwen-a-3b",
    "qwen/qwen-b-3b",
    "qwen/qwen-c-3b",
    "qwen/qwen-d-3b",
    "mistralai/ministral-3b",
  ];
  const picked = pickModelsForOlympics(all, undefined, 4, ["s"]);
  assert.ok(picked.includes("mistralai/ministral-3b"), `mistral should be included; got ${picked.join(", ")}`);
});

/* ─── New tests: paramsString-based weight classification ──────────── */

test("classifyWeight: uses paramsString when available (v1 API)", () => {
  assert.equal(classifyWeight("custom-model-no-marker", "4B"), "s");
  assert.equal(classifyWeight("custom-model-no-marker", "27B"), "l");
  assert.equal(classifyWeight("custom-model-no-marker", "671B"), "xl");
  assert.equal(classifyWeight("custom-model-no-marker", "0.6B"), "xs");
  assert.equal(classifyWeight("custom-model-no-marker", "26B-A4B"), "l");
  assert.equal(classifyWeight("zai-org/glm-4.7-flash", null), "unknown");
  assert.equal(classifyWeight("custom-model-9b", "9B"), "m");
});

test("classifyWeight: paramsString overrides name-based guess", () => {
  assert.equal(classifyWeight("my-model-3b", "12B"), "m");
  assert.equal(classifyWeight("model-70b", "4B"), "s");
});

/* ─── pickModelsForOlympicsV1: capability-aware selection ─────────── */

function makeFakeModel(key: string, overrides: Partial<LmsModelInfo> = {}): LmsModelInfo {
  return {
    key, type: "llm", publisher: "", displayName: key, architecture: "",
    quantization: { name: "Q4_K_M", bits_per_weight: 4 }, sizeBytes: 0,
    paramsString: null, loadedInstances: [], maxContextLength: 0, format: "gguf",
    capabilities: { vision: false, trained_for_tool_use: false }, description: null,
    ...overrides,
  };
}

test("pickModelsForOlympicsV1: uses paramsString for weight classification", () => {
  const models = [
    makeFakeModel("custom-alpha", { paramsString: "4B" }),
    makeFakeModel("custom-beta", { paramsString: "9B" }),
    makeFakeModel("custom-gamma", { paramsString: "27B" }),
  ];
  const picked = pickModelsForOlympicsV1(models, undefined, 3, ["s"]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].key, "custom-alpha");
});

test("pickModelsForOlympicsV1: prefers loaded models", () => {
  const models = [
    makeFakeModel("model-a-4b", { paramsString: "4B" }),
    makeFakeModel("model-b-4b", { paramsString: "4B", loadedInstances: [{ id: "model-b-4b", config: {} }] }),
  ];
  const picked = pickModelsForOlympicsV1(models, undefined, 1, ["s"]);
  assert.equal(picked[0].key, "model-b-4b", "loaded model should be preferred");
});

test("pickModelsForOlympicsV1: diversifies by architecture", () => {
  const models = [
    makeFakeModel("pub/qwen-a-4b", { paramsString: "4B", architecture: "qwen3" }),
    makeFakeModel("pub/qwen-b-4b", { paramsString: "4B", architecture: "qwen3" }),
    makeFakeModel("pub/gemma-4b", { paramsString: "4B", architecture: "gemma4" }),
    makeFakeModel("pub/mistral-3b", { paramsString: "3B", architecture: "mistral3" }),
  ];
  const picked = pickModelsForOlympicsV1(models, undefined, 3, ["s"]);
  const archs = new Set(picked.map((p) => p.architecture));
  assert.ok(archs.size >= 2, `expected >=2 architectures, got: ${[...archs].join(", ")}`);
});
