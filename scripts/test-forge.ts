/**
 * Phase 3.2 — Forge format / configgen / pipeline tests.
 * Run: `npx tsx scripts/test-forge.ts`
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  shareGptToChatML,
  chatMLToShareGPT,
  detectFormat,
  parseAsChatML,
  chatMLLinesToJsonl,
  splitLines,
  ShareGPTLineSchema,
  ChatMLLineSchema,
  generateUnslothPython,
  generateAxolotlYaml,
  ForgeSpecSchema,
  prepareDataset,
  generateBundle,
} from "../electron/lib/forge/index.js";

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function makeSpec(overrides: Record<string, unknown> = {}) {
  return ForgeSpecSchema.parse({
    runId: "test-run-1",
    baseModel: "unsloth/Qwen3-4B-Instruct-2507",
    datasetPath: "data/test/train.jsonl",
    ...overrides,
  });
}

async function main(): Promise<void> {
  console.log("Phase 3.2 — Forge format/configgen/pipeline tests\n");

  // ─── Format ──
  console.log("[format — converters]");

  step("ShareGPT → ChatML маппинг ролей", () => {
    const sg = ShareGPTLineSchema.parse({
      conversations: [
        { from: "system", value: "you are helpful" },
        { from: "human", value: "hi" },
        { from: "gpt", value: "hello" },
      ],
    });
    const cm = shareGptToChatML(sg);
    assert(cm.messages[0]!.role === "system", "system role");
    assert(cm.messages[1]!.role === "user", "human → user");
    assert(cm.messages[2]!.role === "assistant", "gpt → assistant");
  });

  step("ChatML → ShareGPT round-trip без потерь", () => {
    const cm = ChatMLLineSchema.parse({
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A" },
      ],
    });
    const sg = chatMLToShareGPT(cm);
    const cm2 = shareGptToChatML(sg);
    assert(JSON.stringify(cm.messages) === JSON.stringify(cm2.messages), "round-trip mismatch");
  });

  step("detectFormat распознаёт оба формата", () => {
    assert(detectFormat({ conversations: [] }) === "sharegpt", "sharegpt");
    assert(detectFormat({ messages: [] }) === "chatml", "chatml");
    assert(detectFormat({ random: 1 }) === "unknown", "unknown");
  });

  step("parseAsChatML переваривает смешанный JSONL", () => {
    const jsonl = [
      JSON.stringify({ conversations: [{ from: "human", value: "q1" }, { from: "gpt", value: "a1" }] }),
      JSON.stringify({ messages: [{ role: "user", content: "q2" }, { role: "assistant", content: "a2" }] }),
      "garbage line",
      "",
      JSON.stringify({ random: 1 }),
    ].join("\n");
    const { lines, errors } = parseAsChatML(jsonl);
    assert(lines.length === 2, `expected 2 valid, got ${lines.length}`);
    assert(errors.length === 2, `expected 2 errors (garbage + unknown format), got ${errors.length}`);
  });

  step("chatMLLinesToJsonl + parseAsChatML round-trip", () => {
    const original = [
      ChatMLLineSchema.parse({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }),
    ];
    const out = chatMLLinesToJsonl(original);
    const { lines } = parseAsChatML(out);
    assert(JSON.stringify(lines) === JSON.stringify(original), "round-trip");
  });

  // ─── Split ──
  console.log("\n[format — split]");

  step("splitLines стабильный с одним seed", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const a = splitLines(data, { trainRatio: 0.8, evalRatio: 0.1, seed: 42 });
    const b = splitLines(data, { trainRatio: 0.8, evalRatio: 0.1, seed: 42 });
    assert(JSON.stringify(a) === JSON.stringify(b), "seed must be deterministic");
  });

  step("splitLines правильные размеры", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const r = splitLines(data, { trainRatio: 0.9, evalRatio: 0.1 });
    assert(r.eval.length === 10, `eval=10, got ${r.eval.length}`);
    assert(r.train.length === 81, `train=81, got ${r.train.length}`); // 90 * 0.9 = 81
    assert(r.val.length === 9, `val=9, got ${r.val.length}`);
  });

  step("разные seed → разные результаты", () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const a = splitLines(data, { seed: 1 });
    const b = splitLines(data, { seed: 2 });
    assert(JSON.stringify(a.train) !== JSON.stringify(b.train), "different seeds → different shuffles");
  });

  // ─── Configgen ──
  console.log("\n[configgen]");

  step("generateUnslothPython содержит ключевые токены", () => {
    const py = generateUnslothPython(makeSpec({ loraR: 16 }));
    assert(py.includes("FastLanguageModel.from_pretrained"), "from_pretrained");
    assert(py.includes("r=16"), "r=16");
    assert(py.includes("save_pretrained_gguf"), "GGUF export");
  });

  step("generateUnslothPython с YaRN добавляет rope_scaling", () => {
    const py = generateUnslothPython(makeSpec({
      useYarn: true,
      yarnFactor: 4.0,
      maxSeqLength: 131072,
      nativeContextLength: 32768,
    }));
    assert(py.includes('rope_scaling={"type": "yarn"'), "rope_scaling block");
    assert(py.includes('"factor": 4'), "factor=4");
    assert(py.includes('"original_max_position_embeddings": 32768'), "native context written");
  });

  step("generateUnslothPython без YaRN не содержит rope_scaling", () => {
    const py = generateUnslothPython(makeSpec({ useYarn: false, yarnFactor: 1.0 }));
    assert(!py.includes("rope_scaling"), "rope_scaling MUST NOT appear when useYarn=false");
  });

  step("generateAxolotlYaml содержит datasets + lora", () => {
    const yaml = generateAxolotlYaml(makeSpec({ method: "qlora" }));
    assert(yaml.includes("base_model:"), "base_model");
    assert(yaml.includes("load_in_4bit: true"), "qlora flag");
  });

  step("generateAxolotlYaml с YaRN записывает rope_scaling.yarn", () => {
    const yaml = generateAxolotlYaml(makeSpec({
      method: "qlora",
      useYarn: true,
      yarnFactor: 4.0,
      maxSeqLength: 131072,
      nativeContextLength: 32768,
    }));
    assert(yaml.includes("rope_scaling:"), "rope_scaling key");
    assert(yaml.includes("type: yarn"), "yarn type");
    assert(yaml.includes("factor: 4"), "factor 4");
  });

  step("ForgeSpec rejects malformed", () => {
    let threw = false;
    try {
      ForgeSpecSchema.parse({ runId: "" });
    } catch {
      threw = true;
    }
    assert(threw, "schema must reject empty runId");
  });

  step("дефолты соответствуют 2026 консенсусу", () => {
    const spec = ForgeSpecSchema.parse({ runId: "x", baseModel: "x/x", datasetPath: "x.jsonl" });
    assert(spec.loraR === 16, "default r=16");
    assert(spec.loraAlpha === 32, "default α=32");
    assert(spec.useDora === true, "DoRA on by default");
    assert(spec.learningRate === 2e-4, "lr=2e-4");
    assert(spec.numEpochs === 2, "epochs=2");
    assert(spec.useYarn === false, "useYarn off by default");
    assert(spec.yarnFactor === 1.0, "yarnFactor=1.0 by default");
  });

  step("ForgeSpec backward-compat: старые поля pushToHub/hubModelId игнорируются", () => {
    const spec = ForgeSpecSchema.parse({
      runId: "legacy",
      baseModel: "x/x",
      datasetPath: "x.jsonl",
      pushToHub: true,
      hubModelId: "user/model",
    });
    assert(spec.runId === "legacy", "must accept and parse legacy spec");
    assert(!("pushToHub" in spec), "pushToHub MUST be stripped from new spec");
    assert(!("hubModelId" in spec), "hubModelId MUST be stripped from new spec");
  });

  // ─── Pipeline ──
  console.log("\n[pipeline]");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-forge-"));
  try {
    const sourceJsonl = path.join(dir, "source.jsonl");
    const sample = Array.from({ length: 30 }, (_, i) => ({
      conversations: [
        { from: "system", value: "system" },
        { from: "human", value: `q${i}` },
        { from: "gpt", value: `a${i}` },
      ],
    }));
    await fs.writeFile(sourceJsonl, sample.map((s) => JSON.stringify(s)).join("\n"));

    await step("prepareDataset создаёт train/val/eval", async () => {
      const result = await prepareDataset({
        spec: makeSpec(),
        sourceJsonl,
        workspaceDir: path.join(dir, "ws"),
        trainRatio: 0.9,
        evalRatio: 0.1,
      });
      assert(result.counts.total === 30, `total=30, got ${result.counts.total}`);
      assert(result.counts.eval === 3, `eval=3, got ${result.counts.eval}`);
      assert(result.counts.train + result.counts.val === 27, "train+val should be 27");
      assert(await fileExists(result.trainPath), "train.jsonl exists");
      assert(await fileExists(result.valPath), "val.jsonl exists");
      assert(await fileExists(result.evalPath), "eval.jsonl exists");
    });

    await step("generateBundle создаёт workspace из 3 файлов (self-hosted)", async () => {
      const ws = path.join(dir, "bundle");
      const result = await generateBundle({ spec: makeSpec(), workspaceDir: ws });
      assert(result.files.length === 3, `expected 3 files, got ${result.files.length}`);
      const names = new Set(result.files);
      assert(names.has("test-run-1.py"), "missing train.py");
      assert(names.has("test-run-1-axolotl.yaml"), "missing axolotl.yaml");
      assert(names.has("README.md"), "missing README.md");
      for (const f of result.files) {
        assert(await fileExists(path.join(ws, f)), `${f} missing`);
      }
    });

    await step("generateBundle НЕ создаёт AutoTrain YAML или Colab notebook", async () => {
      const ws = path.join(dir, "bundle-no-cloud");
      const result = await generateBundle({ spec: makeSpec({ runId: "no-cloud" }), workspaceDir: ws });
      const names = new Set(result.files);
      assert(!names.has("no-cloud.yaml"), "AutoTrain yaml MUST NOT be generated");
      assert(!names.has("no-cloud.ipynb"), "Colab notebook MUST NOT be generated");
    });
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
      await fs.rm(dir, { recursive: true, force: true }).catch((err) => console.error("[test-forge/cleanup] rm Error:", err));
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
