/**
 * Unit tests for electron/lib/llm/model-role-resolver.ts
 *
 * After the project trim the resolver has 5 roles:
 *   crystallizer, judge, vision_meta, vision_ocr, evaluator
 *
 * Resolve chain: preference → fallback_list → auto_detect → fallback_any → null.
 *
 * Uses injectable deps (_setResolverDepsForTests) — no real LM Studio needed.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  listAllRoles,
  modelRoleResolver,
  peekRoleCaps,
  resolveCrystallizerModelKey,
  _setResolverDepsForTests,
  _resetResolverForTests,
  type ModelRole,
} from "../electron/lib/llm/model-role-resolver.ts";
import type { LoadedModelInfo } from "../electron/lmstudio-client.ts";
import type { Preferences } from "../electron/lib/preferences/store.ts";

/* ── helpers ────────────────────────────────────────────────────────── */

function makeModel(modelKey: string, overrides: Partial<LoadedModelInfo> = {}): LoadedModelInfo {
  return { identifier: modelKey, modelKey, ...overrides };
}

function makePrefs(overrides: Partial<Preferences> = {}): Preferences {
  return {
    extractorModel: "",
    judgeModel: "",
    visionModelKey: "",
    evaluatorModel: "",
    extractorModelFallbacks: "",
    judgeModelFallbacks: "",
    visionModelFallbacks: "",
    evaluatorModelFallbacks: "",
    modelRoleCacheTtlMs: 0,
    ...overrides,
  } as unknown as Preferences;
}

/* ── setup ──────────────────────────────────────────────────────────── */

beforeEach(() => {
  _resetResolverForTests();
  modelRoleResolver.invalidate();
});

test("[model-role-resolver] listAllRoles exposes stable UI metadata for all roles", () => {
  const metas = listAllRoles();
  assert.deepEqual(metas.map((m) => m.role), [
    "crystallizer",
    "judge",
    "vision_meta",
    "vision_ocr",
    "evaluator",
    "ukrainian_specialist",
    "lang_detector",
    "translator",
  ]);
  for (const meta of metas) {
    assert.equal(typeof meta.prefKey, "string");
    assert.ok(meta.prefKey.length > 0, `${meta.role} must expose a prefKey`);
    assert.ok(Array.isArray(meta.required), `${meta.role} required caps must be an array`);
    assert.ok(Array.isArray(meta.preferred), `${meta.role} preferred caps must be an array`);
  }
  assert.equal(metas.find((m) => m.role === "vision_meta")?.required.includes("vision"), true);
});

/* ── preference (step 1) ────────────────────────────────────────────── */

describe("[model-role-resolver] preference source", () => {
  test("resolves explicit preferences for judge, evaluator, crystallizer, and vision_ocr", async () => {
    const cases: Array<{ role: ModelRole; pref: Partial<Preferences>; modelKey: string; caps?: Partial<LoadedModelInfo> }> = [
      { role: "judge", pref: { judgeModel: "judge/main" }, modelKey: "judge/main" },
      { role: "evaluator", pref: { evaluatorModel: "eval/main" }, modelKey: "eval/main" },
      { role: "crystallizer", pref: { extractorModel: "extract/main" }, modelKey: "extract/main" },
      { role: "vision_ocr", pref: { visionModelKey: "vision/main" }, modelKey: "vision/main", caps: { vision: true } },
    ];

    for (const item of cases) {
      _resetResolverForTests();
      modelRoleResolver.invalidate();
      _setResolverDepsForTests({
        listLoaded: async () => [makeModel(item.modelKey, item.caps)],
        getPrefs: async () => makePrefs(item.pref),
      });
      const resolved = await modelRoleResolver.resolve(item.role);
      assert.ok(resolved !== null, `${item.role} should resolve`);
      assert.equal(resolved!.modelKey, item.modelKey);
      assert.equal(resolved!.source, "preference");
    }
  });

  test("skips preference when preferred model is not in loaded list", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("qwen/available-model")],
      getPrefs: async () => makePrefs({ extractorModel: "ghost/not-loaded" }),
    });
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.ok(r !== null);
    assert.notEqual(r!.source, "preference");
    assert.equal(r!.usedFallback, true);
  });
});

/* ── fallback_list (step 2) ─────────────────────────────────────────── */

describe("[model-role-resolver] fallback_list source", () => {
  test("returns first matching CSV fallback when primary pref empty", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("fallback/second"), makeModel("fallback/third")],
      getPrefs: async () => makePrefs({
        extractorModel: "",
        extractorModelFallbacks: "fallback/first,fallback/second,fallback/third",
      }),
    });
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "fallback/second", "should pick first loaded from CSV");
    assert.equal(r!.source, "fallback_list");
  });

  test("uses role-specific fallback lists for judge, evaluator, and vision_ocr", async () => {
    const cases: Array<{ role: ModelRole; pref: Partial<Preferences>; modelKey: string; caps?: Partial<LoadedModelInfo> }> = [
      { role: "judge", pref: { judgeModelFallbacks: "ghost,judge/fallback" }, modelKey: "judge/fallback" },
      { role: "evaluator", pref: { evaluatorModelFallbacks: "ghost,eval/fallback" }, modelKey: "eval/fallback" },
      { role: "vision_ocr", pref: { visionModelFallbacks: "ghost,vision/fallback" }, modelKey: "vision/fallback", caps: { vision: true } },
    ];

    for (const item of cases) {
      _resetResolverForTests();
      modelRoleResolver.invalidate();
      _setResolverDepsForTests({
        listLoaded: async () => [makeModel(item.modelKey, item.caps)],
        getPrefs: async () => makePrefs(item.pref),
      });
      const resolved = await modelRoleResolver.resolve(item.role);
      assert.ok(resolved !== null, `${item.role} should resolve`);
      assert.equal(resolved!.modelKey, item.modelKey);
      assert.equal(resolved!.source, "fallback_list");
    }
  });
});

/* ── auto_detect / fallback_any (steps 3-4) ────────────────────────── */

describe("[model-role-resolver] auto_detect and fallback_any", () => {
  test("returns null when no models loaded", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [],
      getPrefs: async () => makePrefs({}),
    });
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.equal(r, null);
  });

  test("returns first loaded model when prefs empty", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("any/model"), makeModel("any/second")],
      getPrefs: async () => makePrefs({}),
    });
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "any/model");
    assert.ok(
      r!.source === "auto_detect" || r!.source === "fallback_any",
      `expected auto_detect or fallback_any, got: ${r!.source}`,
    );
    assert.equal(r!.usedFallback, true);
  });
});

/* ── capability filtering (vision roles) ───────────────────────────── */

describe("[model-role-resolver] vision role capability filtering", () => {
  test("vision_meta only considers models with vision=true", async () => {
    const textOnly = makeModel("text/only", { vision: false });
    const visionModel = makeModel("qwen/qwen3-vl", { vision: true });
    _setResolverDepsForTests({
      listLoaded: async () => [textOnly, visionModel],
      getPrefs: async () => makePrefs({}),
    });
    const r = await modelRoleResolver.resolve("vision_meta");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, visionModel.modelKey, "must pick vision-capable model");
  });

  test("vision_meta returns null when no vision-capable model loaded", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("text/only", { vision: false }), makeModel("another/text", { vision: false })],
      getPrefs: async () => makePrefs({}),
    });
    const r = await modelRoleResolver.resolve("vision_meta");
    assert.equal(r, null, "should return null when no vision models");
  });

  test("vision_ocr shares the vision capability requirement", async () => {
    assert.deepEqual(peekRoleCaps("vision_ocr"), ["vision"]);
    const visionModel = makeModel("qwen/vl-ocr", { vision: true });
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("text/only", { vision: false }), visionModel],
      getPrefs: async () => makePrefs({}),
    });
    const r = await modelRoleResolver.resolve("vision_ocr");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, visionModel.modelKey);
  });
});

/* ── resolveCrystallizerModelKey convenience ────────────────────────── */

describe("[model-role-resolver] resolveCrystallizerModelKey", () => {
  test("delegates to crystallizer role", async () => {
    const extractor = "extractor/preferred";
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel(extractor)],
      getPrefs: async () => makePrefs({ extractorModel: extractor }),
    });
    const r = await resolveCrystallizerModelKey();
    assert.ok(r !== null);
    assert.equal(r!.modelKey, extractor);
    assert.equal(r!.source, "preference");
  });
});

/* ── cache TTL + invalidate ─────────────────────────────────────────── */

describe("[model-role-resolver] TTL cache", () => {
  test("cache is bypassed when TTL=0", async () => {
    let callCount = 0;
    _setResolverDepsForTests({
      listLoaded: async () => { callCount++; return [makeModel("m/1")]; },
      getPrefs: async () => makePrefs({ modelRoleCacheTtlMs: 0 }),
    });
    await modelRoleResolver.resolve("crystallizer");
    await modelRoleResolver.resolve("crystallizer");
    assert.ok(callCount >= 2, "with TTL=0 each resolve should call listLoaded");
  });

  test("invalidate clears cached result", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("model/first")],
      getPrefs: async () => makePrefs({ modelRoleCacheTtlMs: 60_000 }),
    });
    const r1 = await modelRoleResolver.resolve("crystallizer");
    assert.equal(r1!.modelKey, "model/first");

    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("model/second")],
      getPrefs: async () => makePrefs({ modelRoleCacheTtlMs: 60_000 }),
    });
    modelRoleResolver.invalidate("crystallizer");
    const r2 = await modelRoleResolver.resolve("crystallizer");
    assert.equal(r2!.modelKey, "model/second", "after invalidate should re-resolve");
  });
});
