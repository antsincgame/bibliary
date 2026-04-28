/**
 * Unit tests for electron/lib/llm/model-role-resolver.ts
 *
 * Тестирует цепочку резолва: preference → fallback_list → arena_top_elo →
 * profile_builtin → auto_detect → fallback_any → null.
 * Capability filtering для vision_* ролей.
 * TTL кэш + invalidate.
 *
 * Использует injectable deps (_setResolverDepsForTests) — без реального LM Studio.
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
    chatModel: "",
    agentModel: "",
    extractorModel: "",
    judgeModel: "",
    visionModelKey: "",
    evaluatorModel: "",
    arenaJudgeModelKey: "",
    chatModelFallbacks: "",
    agentModelFallbacks: "",
    extractorModelFallbacks: "",
    judgeModelFallbacks: "",
    visionModelFallbacks: "",
    evaluatorModelFallbacks: "",
    arenaEnabled: false,
    arenaUseLlmJudge: false,
    arenaAutoPromoteWinner: false,
    arenaMatchPairsPerCycle: 3,
    arenaCycleIntervalMs: 3_600_000,
    modelRoleCacheTtlMs: 0, /* disable cache in tests for fresh resolve each call */
    ...overrides,
  } as unknown as Preferences;
}

function makeRatings(roleData: Record<string, Record<string, number>>) {
  return { version: 1 as const, roles: roleData };
}

/* ── setup ──────────────────────────────────────────────────────────── */

beforeEach(() => {
  _resetResolverForTests();
  modelRoleResolver.invalidate();
});

test("[model-role-resolver] listAllRoles exposes stable UI metadata for all roles", () => {
  const metas = listAllRoles();
  assert.deepEqual(metas.map((m) => m.role), [
    "chat",
    "agent",
    "crystallizer",
    "judge",
    "vision_meta",
    "vision_ocr",
    "evaluator",
    "arena_judge",
  ]);
  for (const meta of metas) {
    assert.equal(typeof meta.prefKey, "string");
    assert.ok(meta.prefKey.length > 0, `${meta.role} must expose a prefKey`);
    assert.ok(Array.isArray(meta.required), `${meta.role} required caps must be an array`);
    assert.ok(Array.isArray(meta.preferred), `${meta.role} preferred caps must be an array`);
  }
  assert.equal(metas.find((m) => m.role === "vision_meta")?.required.includes("vision"), true);
  assert.equal(metas.find((m) => m.role === "agent")?.preferred.includes("tool"), true);
});

/* ── preference (step 1) ────────────────────────────────────────────── */

describe("[model-role-resolver] preference source", () => {
  test("returns preference when chatModel is set and model is loaded", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("openai/gpt4-mini"), makeModel("qwen/chat-7b")],
      getPrefs: async () => makePrefs({ chatModel: "qwen/chat-7b" }),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "qwen/chat-7b");
    assert.equal(r!.source, "preference");
    assert.equal(r!.usedFallback, undefined);
  });

  test("skips preference when preferred model is not in loaded list", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("qwen/available-model")],
      getPrefs: async () => makePrefs({ chatModel: "ghost/not-loaded" }),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    // falls through to auto_detect or fallback_any
    assert.notEqual(r!.source, "preference");
    assert.equal(r!.usedFallback, true);
  });

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
        readRatings: async () => makeRatings({}),
      });
      const resolved = await modelRoleResolver.resolve(item.role);
      assert.ok(resolved !== null, `${item.role} should resolve`);
      assert.equal(resolved!.modelKey, item.modelKey);
      assert.equal(resolved!.source, "preference");
    }
  });
});

/* ── fallback_list (step 2) ─────────────────────────────────────────── */

describe("[model-role-resolver] fallback_list source", () => {
  test("returns first matching CSV fallback when primary pref empty", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("fallback/second"), makeModel("fallback/third")],
      getPrefs: async () => makePrefs({
        chatModel: "",
        chatModelFallbacks: "fallback/first,fallback/second,fallback/third",
      }),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "fallback/second", "should pick first loaded from CSV");
    assert.equal(r!.source, "fallback_list");
  });

  test("skips fallbacks not in loaded list", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("only/model")],
      getPrefs: async () => makePrefs({
        chatModelFallbacks: "ghost/a,ghost/b,only/model",
      }),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "only/model");
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
        readRatings: async () => makeRatings({}),
      });
      const resolved = await modelRoleResolver.resolve(item.role);
      assert.ok(resolved !== null, `${item.role} should resolve`);
      assert.equal(resolved!.modelKey, item.modelKey);
      assert.equal(resolved!.source, "fallback_list");
    }
  });
});

/* ── arena_top_elo (step 3) ─────────────────────────────────────────── */

describe("[model-role-resolver] arena_top_elo source", () => {
  test("returns top-Elo model when prefs empty and ratings exist", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("model/a"), makeModel("model/b"), makeModel("model/c")],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({
        chat: { "model/a": 1600, "model/b": 1400, "model/c": 1550 },
      }),
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "model/a", "highest Elo wins");
    assert.equal(r!.source, "arena_top_elo");
  });

  test("ignores Elo for models not currently loaded", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("model/loaded")],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({
        chat: { "model/not-loaded": 2000, "model/loaded": 1450 },
      }),
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "model/loaded");
  });

  test("gracefully handles missing role bucket in ratings", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("model/x")],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({ agent: { "model/x": 1600 } }), // chat missing
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    // falls through to auto_detect / fallback_any
    assert.notEqual(r!.source, "arena_top_elo");
  });
});

/* ── profile_builtin (step 4) ───────────────────────────────────────── */

describe("[model-role-resolver] profile_builtin source", () => {
  test("crystallizer falls back to BIG profile when loaded", async () => {
    const bigKey = "qwen/qwen3-35b-a22b";
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel(bigKey)],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({}),
      getProfileById: async (id) => id === "BIG" ? { modelKey: bigKey } : null,
    });
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, bigKey);
    assert.equal(r!.source, "profile_builtin");
  });

  test("chat role does NOT use profile_builtin", async () => {
    const bigKey = "qwen/qwen3-35b-a22b";
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel(bigKey)],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({}),
      getProfileById: async (id) => id === "BIG" ? { modelKey: bigKey } : null,
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    // chat should reach fallback_any, not profile_builtin
    assert.notEqual(r!.source, "profile_builtin");
  });

  test("resolveCrystallizerModelKey delegates to crystallizer role", async () => {
    const extractor = "extractor/preferred";
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel(extractor)],
      getPrefs: async () => makePrefs({ extractorModel: extractor }),
      readRatings: async () => makeRatings({}),
    });
    const r = await resolveCrystallizerModelKey();
    assert.ok(r !== null);
    assert.equal(r!.modelKey, extractor);
    assert.equal(r!.source, "preference");
  });
});

/* ── auto_detect / fallback_any (steps 5-6) ────────────────────────── */

describe("[model-role-resolver] auto_detect and fallback_any", () => {
  test("returns null when no models loaded", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.equal(r, null);
  });

  test("returns first loaded model when prefs empty and no arena data", async () => {
    /* When ROLE_PREFERRED_CAPS["chat"] = [] (no preferred caps), pickByPreferredCaps
       returns the first eligible model via "auto_detect" source (step 6). The
       "fallback_any" source (step 7) is only reached when auto_detect returns null,
       which can't happen if loaded.length > 0 and preferred is empty. */
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("any/model"), makeModel("any/second")],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("chat");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "any/model");
    assert.ok(
      r!.source === "auto_detect" || r!.source === "fallback_any",
      `expected auto_detect or fallback_any, got: ${r!.source}`,
    );
    assert.equal(r!.usedFallback, true);
  });

  test("agent role prefers tool-use capable models (auto_detect)", async () => {
    const visionModel = makeModel("qwen/qwen3-vl-8b", { vision: true, trainedForToolUse: false });
    const toolModel = makeModel("qwen/qwen3-4b", { vision: false, trainedForToolUse: true });
    _setResolverDepsForTests({
      listLoaded: async () => [visionModel, toolModel],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("agent");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, toolModel.modelKey, "agent should prefer tool-use model");
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
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("vision_meta");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, visionModel.modelKey, "must pick vision-capable model");
  });

  test("vision_meta returns null when no vision-capable model loaded", async () => {
    const textOnly = makeModel("text/only", { vision: false });
    const another = makeModel("another/text", { vision: false });
    _setResolverDepsForTests({
      listLoaded: async () => [textOnly, another],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("vision_meta");
    assert.equal(r, null, "should return null when no vision models");
  });

  test("vision_meta preference is honoured only if model has vision=true", async () => {
    const textModel = makeModel("text/preferred", { vision: false });
    const visionModel = makeModel("qwen/vl", { vision: true });
    _setResolverDepsForTests({
      listLoaded: async () => [textModel, visionModel],
      getPrefs: async () => makePrefs({ visionModelKey: textModel.modelKey }),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("vision_meta");
    assert.ok(r !== null);
    // textModel fails capability filter → resolver falls through to visionModel
    assert.equal(r!.modelKey, visionModel.modelKey);
    assert.notEqual(r!.source, "preference");
  });

  test("vision_ocr shares the vision capability requirement", async () => {
    assert.deepEqual(peekRoleCaps("vision_ocr"), ["vision"]);
    const textOnly = makeModel("text/only", { vision: false });
    const visionModel = makeModel("qwen/vl-ocr", { vision: true });
    _setResolverDepsForTests({
      listLoaded: async () => [textOnly, visionModel],
      getPrefs: async () => makePrefs({}),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("vision_ocr");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, visionModel.modelKey);
  });
});

/* ── arena_judge cascade ────────────────────────────────────────────── */

describe("[model-role-resolver] arena_judge cascade", () => {
  test("arena_judge cascades to judge then crystallizer then chat", async () => {
    const chatModel = makeModel("chat/default");
    _setResolverDepsForTests({
      listLoaded: async () => [chatModel],
      getPrefs: async () => makePrefs({
        arenaJudgeModelKey: "",
        judgeModel: "",
        extractorModel: "",
        chatModel: chatModel.modelKey,
      }),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("arena_judge");
    assert.ok(r !== null, "arena_judge should cascade to chat");
    assert.equal(r!.modelKey, chatModel.modelKey);
    assert.equal(r!.usedFallback, true);
  });

  test("arena_judge cascade prefers judge before crystallizer and chat", async () => {
    const judge = makeModel("judge/preferred");
    const extractor = makeModel("extract/preferred");
    const chat = makeModel("chat/preferred");
    _setResolverDepsForTests({
      listLoaded: async () => [chat, extractor, judge],
      getPrefs: async () => makePrefs({
        judgeModel: judge.modelKey,
        extractorModel: extractor.modelKey,
        chatModel: chat.modelKey,
      }),
      readRatings: async () => makeRatings({}),
    });
    const r = await modelRoleResolver.resolve("arena_judge");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, judge.modelKey);
    assert.equal(r!.usedFallback, true);
  });
});

/* ── cache TTL + invalidate ─────────────────────────────────────────── */

describe("[model-role-resolver] TTL cache", () => {
  test("cache is bypassed when TTL=0", async () => {
    let callCount = 0;
    _setResolverDepsForTests({
      listLoaded: async () => { callCount++; return [makeModel("m/1")]; },
      getPrefs: async () => makePrefs({ modelRoleCacheTtlMs: 0 }),
      readRatings: async () => makeRatings({}),
    });
    await modelRoleResolver.resolve("chat");
    await modelRoleResolver.resolve("chat");
    assert.ok(callCount >= 2, "with TTL=0 each resolve should call listLoaded");
  });

  test("invalidate clears cached result", async () => {
    let firstModel = "model/first";
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel(firstModel)],
      getPrefs: async () => makePrefs({ modelRoleCacheTtlMs: 60_000 }),
      readRatings: async () => makeRatings({}),
    });
    const r1 = await modelRoleResolver.resolve("chat");
    assert.equal(r1!.modelKey, "model/first");

    // change what listLoaded returns + invalidate
    firstModel = "model/second";
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("model/second")],
      getPrefs: async () => makePrefs({ modelRoleCacheTtlMs: 60_000 }),
      readRatings: async () => makeRatings({}),
    });
    modelRoleResolver.invalidate("chat");
    const r2 = await modelRoleResolver.resolve("chat");
    assert.equal(r2!.modelKey, "model/second", "after invalidate should re-resolve");
  });
});
