/**
 * Phase 3.0 — Memory Forge engine + patcher tests.
 * Run: `npx tsx scripts/test-yarn-engine.ts`
 * Exit code 0 on success, 1 on any failure.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  getModelArch,
  listKnownModels,
  computeRopeScaling,
  isYarnNeeded,
  estimateKVCache,
  recommendKVDtype,
  recommend,
  presetForTokens,
  TASK_PRESETS,
} from "../electron/lib/yarn/engine.js";
import { buildSuggestions } from "../electron/lib/yarn/suggestions.js";
import {
  applyRopeScaling,
  revertRopeScaling,
  readCurrentRopeScaling,
  hasBackup,
  resolveConfigPath,
  resolveBackupPath,
} from "../electron/lib/yarn/lmstudio-patcher.js";

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

async function makeTempLMStudio(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-yarn-"));
  process.env.LMSTUDIO_MODELS_DIR = root;
  return {
    root,
    cleanup: async () => {
      delete process.env.LMSTUDIO_MODELS_DIR;
      // На Windows ослабляем cleanup — lockfile может удерживать handle.
      try {
        await fs.rm(root, { recursive: true, force: true });
      } catch {
        await new Promise((r) => setTimeout(r, 100));
        await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function testEngine(): void {
  console.log("\n[engine — getModelArch / listKnownModels]");

  step("known model resolves", () => {
    const arch = getModelArch("qwen/qwen3.6-35b-a3b");
    assert(arch.nativeTokens === 262144, `expected 262144, got ${arch.nativeTokens}`);
    assert(arch.nLayers === 64, "Qwen3.6 should have 64 layers");
    assert(arch.moe === true, "Qwen3.6 35B-A3B is MoE");
  });

  step("case-insensitive lookup", () => {
    const arch = getModelArch("Qwen/Qwen3-8B");
    assert(arch.nativeTokens === 131072, `expected 131072, got ${arch.nativeTokens}`);
  });

  step("unknown model returns fallback with original key", () => {
    const arch = getModelArch("unknown/random-model");
    assert(arch.modelKey === "unknown/random-model", "modelKey preserved");
    assert(arch.family === "unknown", "fallback family");
    assert(arch.nativeTokens === 4096, "fallback native = 4K");
  });

  step("listKnownModels returns >= 12 entries", () => {
    const list = listKnownModels();
    assert(list.length >= 12, `expected >=12, got ${list.length}`);
    const families = new Set(list.map((m) => m.family));
    for (const f of ["qwen3", "llama3", "mistral", "gemma", "phi3"]) {
      assert(families.has(f as never), `family ${f} missing in DB`);
    }
  });

  console.log("\n[engine — computeRopeScaling]");

  step("returns null when target ≤ native", () => {
    assert(computeRopeScaling(8192, 32768) === null, "should be null for target<native");
    assert(computeRopeScaling(32768, 32768) === null, "should be null for target=native");
    assert(computeRopeScaling(0, 32768) === null, "should be null for target=0");
    assert(computeRopeScaling(-1, 32768) === null, "should be null for negative");
  });

  step("computes correct factor for Qwen3-4B 32K → 128K", () => {
    const scaling = computeRopeScaling(131072, 32768);
    assert(scaling !== null, "should produce scaling");
    assert(scaling!.rope_type === "yarn", "rope_type=yarn");
    assert(scaling!.factor === 4, `factor=4, got ${scaling!.factor}`);
    assert(scaling!.original_max_position_embeddings === 32768, "native preserved");
  });

  step("snaps factor to canonical step (3 → 3, 3.5 → 4)", () => {
    const a = computeRopeScaling(98304, 32768); // raw 3.0 → 3
    assert(a!.factor === 3, `expected 3, got ${a!.factor}`);
    const b = computeRopeScaling(114688, 32768); // raw 3.5 → 4
    assert(b!.factor === 4, `expected 4, got ${b!.factor}`);
  });

  step("isYarnNeeded mirrors computeRopeScaling", () => {
    assert(isYarnNeeded(131072, 32768), "needed");
    assert(!isYarnNeeded(8192, 32768), "not needed");
  });

  console.log("\n[engine — estimateKVCache]");

  step("Qwen3.6-35B at 32K FP16 ≈ 1.0 GB", () => {
    const arch = getModelArch("qwen/qwen3.6-35b-a3b");
    const kv = estimateKVCache(arch, 32768, "fp16");
    // 2 * 64 * 8 * 128 * 32768 * 2 = 8589934592 = 8.0 GB. Этот стресс-кейс — сверка с flozi.net.
    const expectedBytes = 2 * 64 * 8 * 128 * 32768 * 2;
    assert(kv.bytes === expectedBytes, `bytes mismatch: ${kv.bytes} vs ${expectedBytes}`);
    assert(kv.gb >= 7.99 && kv.gb <= 8.01, `expected ~8GB, got ${kv.gb}`);
  });

  step("Q4_0 KV-cache 4× меньше FP16", () => {
    const arch = getModelArch("qwen/qwen3.6-35b-a3b");
    const fp = estimateKVCache(arch, 32768, "fp16").bytes;
    const q4 = estimateKVCache(arch, 32768, "q4_0").bytes;
    assert(fp / q4 === 4, `expected ratio 4, got ${fp / q4}`);
  });

  step("zero context = zero bytes", () => {
    const arch = getModelArch("qwen/qwen3-4b-2507");
    const kv = estimateKVCache(arch, 0, "fp16");
    assert(kv.bytes === 0 && kv.gb === 0, "expected zero");
  });

  console.log("\n[engine — recommendKVDtype]");

  step("выбирает FP16 при изобилии VRAM", () => {
    const arch = getModelArch("qwen/qwen3-4b-2507");
    const dtype = recommendKVDtype(arch, 8192, 100);
    assert(dtype === "fp16", `expected fp16, got ${dtype}`);
  });

  step("опускается до Q8_0 при умеренном дефиците", () => {
    const arch = getModelArch("qwen/qwen3.6-35b-a3b");
    const fpGb = estimateKVCache(arch, 131072, "fp16").gb;
    const q8Gb = estimateKVCache(arch, 131072, "q8_0").gb;
    // Бюджет между Q8 и FP16 → должно выбрать Q8.
    const budget = (fpGb + q8Gb) / 2;
    const dtype = recommendKVDtype(arch, 131072, budget);
    assert(dtype === "q8_0", `expected q8_0, got ${dtype}`);
  });

  step("опускается до Q4_0 при большом дефиците", () => {
    const arch = getModelArch("qwen/qwen3.6-35b-a3b");
    const dtype = recommendKVDtype(arch, 1_048_576, 5);
    assert(dtype === "q4_0", `expected q4_0, got ${dtype}`);
  });

  console.log("\n[engine — recommend()]");

  step("полный recommend для Qwen3-8B → 256K", () => {
    const r = recommend({ modelKey: "qwen/qwen3-8b", targetTokens: 262144, availableForKVGb: 12 });
    assert(r.yarnRequired === true, "yarn required");
    assert(r.ropeScaling?.factor === 2, `factor=2, got ${r.ropeScaling?.factor}`);
    assert(r.kvVariants.fp16.gb > 0, "fp16 estimate exists");
    assert(r.kvVariants.q4_0.gb < r.kvVariants.fp16.gb, "q4 < fp16");
  });

  step("recommend без YaRN при target=native", () => {
    const r = recommend({ modelKey: "qwen/qwen3-8b", targetTokens: 131072 });
    assert(r.yarnRequired === false, "yarn not needed");
    assert(r.ropeScaling === null, "no rope_scaling");
  });

  step("recommend помечает превышение yarnMaxTokens", () => {
    const r = recommend({ modelKey: "qwen/qwen3-4b-2507", targetTokens: 524288 });
    assert(r.exceedsYarnMax === true, "should flag exceeds");
  });

  console.log("\n[engine — task presets]");

  step("TASK_PRESETS содержит 5 пунктов в монотонном порядке", () => {
    assert(TASK_PRESETS.length === 5, `expected 5, got ${TASK_PRESETS.length}`);
    for (let i = 1; i < TASK_PRESETS.length; i++) {
      assert(TASK_PRESETS[i]!.tokens > TASK_PRESETS[i - 1]!.tokens, "must be monotonic");
    }
  });

  step("presetForTokens(100K) → book", () => {
    const p = presetForTokens(100_000);
    assert(p?.id === "book", `expected book, got ${p?.id}`);
  });

  step("presetForTokens(1) → chat", () => {
    const p = presetForTokens(1);
    assert(p?.id === "chat", `expected chat, got ${p?.id}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function testSuggestions(): void {
  console.log("\n[suggestions]");

  step("yarn-not-needed когда target ≤ native", () => {
    const arch = getModelArch("qwen/qwen3-8b");
    const r = recommend({ modelKey: arch.modelKey, targetTokens: 32768 });
    const sugs = buildSuggestions({ arch, recommendation: r, availableForKVGb: 100 });
    assert(sugs.some((s) => s.id === "yarn-not-needed"), "should suggest disable-yarn");
  });

  step("kv-fit предлагает Q8_0 когда FP16 не помещается (нужен YaRN)", () => {
    // Qwen3-4B: native 32K, target 128K → YaRN активен. KV растёт, FP16 не лезет, Q8 лезет.
    const arch = getModelArch("qwen/qwen3-4b-2507");
    const r = recommend({ modelKey: arch.modelKey, targetTokens: 131072 });
    const fpGb = r.kvVariants.fp16.gb;
    const q8Gb = r.kvVariants.q8_0.gb;
    const budget = (fpGb + q8Gb) / 2;
    const sugs = buildSuggestions({ arch, recommendation: r, availableForKVGb: budget });
    const kv = sugs.find((s) => s.id === "kv-fit");
    assert(kv != null, `kv-fit suggestion should appear (fp=${fpGb}, q8=${q8Gb}, budget=${budget})`);
    assert(kv!.action?.kind === "set-kv-dtype", "action kind");
    assert((kv!.action as { dtype: string }).dtype === "q8_0", "should suggest q8_0");
  });

  step("official-supported при YaRN factor ≤ 4 и в пределах yarnMax", () => {
    const arch = getModelArch("qwen/qwen3.6-35b-a3b");
    const r = recommend({ modelKey: arch.modelKey, targetTokens: 524288, availableForKVGb: 100 });
    const sugs = buildSuggestions({ arch, recommendation: r, availableForKVGb: 100 });
    assert(sugs.some((s) => s.id === "official-supported"), "should be officially supported");
  });

  step("exceeds-max при превышении yarnMaxTokens", () => {
    const arch = getModelArch("qwen/qwen3-4b-2507");
    const r = recommend({ modelKey: arch.modelKey, targetTokens: 524288, availableForKVGb: 100 });
    const sugs = buildSuggestions({ arch, recommendation: r, availableForKVGb: 100 });
    assert(sugs.some((s) => s.id === "exceeds-max"), "should flag exceeds");
  });
}

// ─────────────────────────────────────────────────────────────────────────────

async function testPatcher(): Promise<void> {
  console.log("\n[patcher — apply / read / revert]");

  const lm = await makeTempLMStudio();
  try {
    const modelKey = "qwen/qwen3-test";
    const modelDir = path.join(lm.root, modelKey);
    await fs.mkdir(modelDir, { recursive: true });

    await step("apply on missing config.json — создаёт минимальный config", async () => {
      const result = await applyRopeScaling(modelKey, {
        rope_type: "yarn",
        factor: 4,
        original_max_position_embeddings: 32768,
      });
      assert(result.backupCreated === true, "backup created (sentinel)");
      assert(result.hadPriorRopeScaling === false, "no prior scaling");

      const cur = await readCurrentRopeScaling(modelKey);
      assert(cur?.factor === 4, "factor written");
      assert(await hasBackup(modelKey), "backup exists");
    });

    await step("повторный apply не пересоздаёт backup, hadPriorRopeScaling=true", async () => {
      const result = await applyRopeScaling(modelKey, {
        rope_type: "yarn",
        factor: 8,
        original_max_position_embeddings: 32768,
      });
      assert(result.backupCreated === false, "backup not recreated");
      assert(result.hadPriorRopeScaling === true, "prior scaling detected");
      const cur = await readCurrentRopeScaling(modelKey);
      assert(cur?.factor === 8, "factor updated");
    });

    await step("revert удаляет config (sentinel случай)", async () => {
      const result = await revertRopeScaling(modelKey);
      assert(result.restored === true, "restored");
      assert(result.configRemoved === true, "config removed (was created by us)");
      const cur = await readCurrentRopeScaling(modelKey);
      assert(cur === null, "no rope_scaling after revert");
      assert(!(await hasBackup(modelKey)), "backup deleted");
    });

    await step("apply на существующий config сохраняет другие поля", async () => {
      const configPath = resolveConfigPath(modelKey);
      await fs.writeFile(configPath, JSON.stringify({ vendor: "me", custom: 42 }), "utf8");
      const result = await applyRopeScaling(modelKey, {
        rope_type: "yarn",
        factor: 2,
        original_max_position_embeddings: 32768,
      });
      assert(result.backupCreated === true, "backup of real config created");

      const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
      assert(raw.vendor === "me", "vendor preserved");
      assert(raw.custom === 42, "custom field preserved");
      assert(raw.rope_scaling.factor === 2, "rope_scaling added");

      // backup содержит оригинал без rope_scaling
      const bak = JSON.parse(await fs.readFile(resolveBackupPath(modelKey), "utf8"));
      assert(bak.vendor === "me", "backup has vendor");
      assert(bak.rope_scaling === undefined, "backup has no rope_scaling");
    });

    await step("revert восстанавливает оригинал", async () => {
      const result = await revertRopeScaling(modelKey);
      assert(result.restored === true && result.configRemoved === false, "restored from backup");
      const raw = JSON.parse(await fs.readFile(resolveConfigPath(modelKey), "utf8"));
      assert(raw.vendor === "me", "vendor restored");
      assert(raw.rope_scaling === undefined, "rope_scaling gone");
    });

    await step("apply на отсутствующий model dir — ошибка", async () => {
      let threw = false;
      try {
        await applyRopeScaling("never/exists", {
          rope_type: "yarn",
          factor: 4,
          original_max_position_embeddings: 32768,
        });
      } catch (e) {
        threw = e instanceof Error && /not found/i.test(e.message);
      }
      assert(threw, "should throw for missing dir");
    });
  } finally {
    await lm.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Phase 3.0 — Memory Forge tests");

  testEngine();
  testSuggestions();
  await testPatcher();

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
