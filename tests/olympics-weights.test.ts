/* Olympics: weight-class classification + optimum vs champion logic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWeight,
  pickModelsForOlympics,
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
  /* После 2-х qwen семейство «qwen» блокируется, mistral попадает следующим. */
  assert.ok(picked.includes("mistralai/ministral-3b"), `mistral should be included; got ${picked.join(", ")}`);
});
