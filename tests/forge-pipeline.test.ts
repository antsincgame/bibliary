/**
 * Contract tests for forge/pipeline — prepareDataset.
 * Tests are pure FS operations: no LM Studio, no WSL, no network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { prepareDataset, generateBundle } from "../electron/lib/forge/pipeline.ts";
import type { PrepareOptions } from "../electron/lib/forge/pipeline.ts";
import { ForgeSpecSchema } from "../electron/lib/forge/configgen.ts";
import type { ForgeSpec } from "../electron/lib/forge/configgen.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeShareGPTLine(i: number): string {
  return JSON.stringify({
    conversations: [
      { from: "human", value: `question ${i}` },
      { from: "gpt", value: `answer ${i}` },
    ],
  });
}

function makeChatMLLine(i: number): string {
  return JSON.stringify({
    messages: [
      { role: "user", content: `question ${i}` },
      { role: "assistant", content: `answer ${i}` },
    ],
  });
}

async function makeTmpEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-forge-test-"));
  const workspaceDir = path.join(root, "workspace");
  return { root, workspaceDir };
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const MINIMAL_SPEC: ForgeSpec = ForgeSpecSchema.parse({
  runId: "test-run",
  baseModel: "test-model",
  datasetPath: "/tmp/dataset.jsonl",
});

// ─── prepareDataset ──────────────────────────────────────────────────────────

describe("forge pipeline — prepareDataset", () => {
  test("basic ShareGPT JSONL: produces train/val/eval files", async () => {
    const { root, workspaceDir } = await makeTmpEnv();
    try {
      const lines = Array.from({ length: 20 }, (_, i) => makeShareGPTLine(i));
      const sourceJsonl = path.join(root, "source.jsonl");
      await writeFile(sourceJsonl, lines.join("\n"), "utf8");

      const opts: PrepareOptions = {
        spec: MINIMAL_SPEC,
        sourceJsonl,
        workspaceDir,
        trainRatio: 0.8,
        evalRatio: 0,
        seed: 42,
      };

      const result = await prepareDataset(opts);

      assert.equal(result.counts.total, 20);
      assert.ok(result.counts.train > 0, "train set must not be empty");
      assert.ok(result.counts.val >= 0);
      assert.equal(result.parseErrors.length, 0, "no parse errors expected");
      assert.equal(result.trainPath, path.join(workspaceDir, "train.jsonl"));
      assert.equal(result.valPath, path.join(workspaceDir, "val.jsonl"));
      assert.equal(result.evalPath, path.join(workspaceDir, "eval.jsonl"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ChatML JSONL: also accepted without parse errors", async () => {
    const { root, workspaceDir } = await makeTmpEnv();
    try {
      const lines = Array.from({ length: 10 }, (_, i) => makeChatMLLine(i));
      const sourceJsonl = path.join(root, "chatml.jsonl");
      await writeFile(sourceJsonl, lines.join("\n"), "utf8");

      const result = await prepareDataset({
        spec: MINIMAL_SPEC,
        sourceJsonl,
        workspaceDir,
        seed: 1,
      });

      assert.equal(result.counts.total, 10);
      assert.equal(result.parseErrors.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("train + val + eval counts sum equals total", async () => {
    const { root, workspaceDir } = await makeTmpEnv();
    try {
      const lines = Array.from({ length: 100 }, (_, i) => makeShareGPTLine(i));
      const sourceJsonl = path.join(root, "big.jsonl");
      await writeFile(sourceJsonl, lines.join("\n"), "utf8");

      const result = await prepareDataset({
        spec: MINIMAL_SPEC,
        sourceJsonl,
        workspaceDir,
        trainRatio: 0.8,
        evalRatio: 0.1,
        seed: 42,
      });

      const { total, train, val, eval: evalCount } = result.counts;
      assert.equal(train + val + evalCount, total, "counts must sum to total");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("output files contain valid ChatML JSON lines", async () => {
    const { root, workspaceDir } = await makeTmpEnv();
    try {
      const lines = Array.from({ length: 10 }, (_, i) => makeShareGPTLine(i));
      const sourceJsonl = path.join(root, "src.jsonl");
      await writeFile(sourceJsonl, lines.join("\n"), "utf8");

      const result = await prepareDataset({
        spec: MINIMAL_SPEC,
        sourceJsonl,
        workspaceDir,
        trainRatio: 0.9,
        evalRatio: 0,
        seed: 0,
      });

      if (result.counts.train > 0) {
        const trainLines = await readJsonl(result.trainPath);
        for (const line of trainLines) {
          assert.ok(typeof line === "object" && line !== null, "each line must be an object");
          assert.ok(Array.isArray((line as { messages?: unknown }).messages), "must have messages array");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("corrupted JSONL lines produce parseErrors, valid lines still processed", async () => {
    const { root, workspaceDir } = await makeTmpEnv();
    try {
      const lines = [
        makeShareGPTLine(0),
        "{ INVALID JSON <<<",
        makeShareGPTLine(1),
        "",
        makeShareGPTLine(2),
      ];
      const sourceJsonl = path.join(root, "mixed.jsonl");
      await writeFile(sourceJsonl, lines.join("\n"), "utf8");

      const result = await prepareDataset({
        spec: MINIMAL_SPEC,
        sourceJsonl,
        workspaceDir,
        seed: 42,
      });

      assert.ok(result.parseErrors.length >= 1, "should have at least 1 parse error");
      assert.equal(result.counts.total, 3, "3 valid lines should be counted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("empty JSONL: zero counts, no train/val/eval lines", async () => {
    const { root, workspaceDir } = await makeTmpEnv();
    try {
      const sourceJsonl = path.join(root, "empty.jsonl");
      await writeFile(sourceJsonl, "", "utf8");

      const result = await prepareDataset({
        spec: MINIMAL_SPEC,
        sourceJsonl,
        workspaceDir,
        seed: 42,
      });

      assert.equal(result.counts.total, 0);
      assert.equal(result.counts.train, 0);
      assert.equal(result.counts.val, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("same seed produces identical split", async () => {
    const { root, workspaceDir: ws1 } = await makeTmpEnv();
    const { root: root2, workspaceDir: ws2 } = await makeTmpEnv();
    try {
      const lines = Array.from({ length: 20 }, (_, i) => makeShareGPTLine(i));
      const src1 = path.join(root, "src.jsonl");
      const src2 = path.join(root2, "src.jsonl");
      await writeFile(src1, lines.join("\n"), "utf8");
      await writeFile(src2, lines.join("\n"), "utf8");

      const r1 = await prepareDataset({ spec: MINIMAL_SPEC, sourceJsonl: src1, workspaceDir: ws1, seed: 777 });
      const r2 = await prepareDataset({ spec: MINIMAL_SPEC, sourceJsonl: src2, workspaceDir: ws2, seed: 777 });

      const train1 = await readJsonl(r1.trainPath);
      const train2 = await readJsonl(r2.trainPath);

      assert.deepEqual(train1, train2, "same seed should produce identical train split");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(root2, { recursive: true, force: true });
    }
  });
});

// ─── generateBundle ──────────────────────────────────────────────────────────

describe("forge pipeline — generateBundle", () => {
  test("creates expected config files in workspace dir", async () => {
    const { root, workspaceDir } = await makeTmpEnv();
    try {
      const result = await generateBundle({ spec: MINIMAL_SPEC, workspaceDir });

      assert.ok(result.files.includes("test-run.py"), "should include unsloth script");
      assert.ok(result.files.includes("test-run-axolotl.yaml"), "should include axolotl config");
      assert.ok(result.files.includes("README.md"), "should include README");
      assert.equal(result.zipPath, null, "no zip in current implementation");
      assert.equal(result.bundleDir, workspaceDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("generated unsloth script contains model name", async () => {
    const { root, workspaceDir } = await makeTmpEnv();
    try {
      const spec: ForgeSpec = { ...MINIMAL_SPEC, baseModel: "unsloth/llama-3-8b" };
      const result = await generateBundle({ spec, workspaceDir });

      const pyPath = path.join(workspaceDir, result.files.find((f) => f.endsWith(".py"))!);
      const content = await readFile(pyPath, "utf8");
      assert.ok(content.includes("unsloth/llama-3-8b"), "script should reference the model");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
