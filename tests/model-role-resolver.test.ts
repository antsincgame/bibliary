/**
 * Unit tests for electron/lib/llm/model-role-resolver.ts
 *
 * MVP v1.0: resolver knows 4 roles:
 *   crystallizer, vision_ocr, vision_illustration, evaluator.
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
    visionModelKey: "",
    evaluatorModel: "",
    extractorModelFallbacks: "",
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
    "vision_ocr",
    "vision_illustration",
    "evaluator",
  ]);
  for (const meta of metas) {
    assert.equal(typeof meta.prefKey, "string");
    assert.ok(meta.prefKey.length > 0, `${meta.role} must expose a prefKey`);
    assert.ok(Array.isArray(meta.required), `${meta.role} required caps must be an array`);
    assert.ok(Array.isArray(meta.preferred), `${meta.role} preferred caps must be an array`);
  }
  assert.equal(metas.find((m) => m.role === "vision_ocr")?.required.includes("vision"), true);
});

/* ── preference (step 1) ────────────────────────────────────────────── */

describe("[model-role-resolver] preference source", () => {
  test("resolves explicit preferences for evaluator, crystallizer, vision_ocr, and vision_illustration", async () => {
    const cases: Array<{ role: ModelRole; pref: Partial<Preferences>; modelKey: string; caps?: Partial<LoadedModelInfo> }> = [
      { role: "evaluator", pref: { evaluatorModel: "eval/main" }, modelKey: "eval/main" },
      { role: "crystallizer", pref: { extractorModel: "extract/main" }, modelKey: "extract/main" },
      { role: "vision_ocr", pref: { visionModelKey: "vision/main" }, modelKey: "vision/main", caps: { vision: true } },
      { role: "vision_illustration", pref: { visionModelKey: "vision/main" }, modelKey: "vision/main", caps: { vision: true } },
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

  test("auto-loads preferred model via pool when not in loaded list", async () => {
    let autoLoadCalled = false;
    let autoLoadedKey = "";
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("qwen/available-model")],
      getPrefs: async () => makePrefs({ extractorModel: "ghost/not-loaded" }),
      autoLoad: async (key) => { autoLoadCalled = true; autoLoadedKey = key; return true; },
    });
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.ok(autoLoadCalled, "autoLoad must be called when preferred not in loaded");
    assert.equal(autoLoadedKey, "ghost/not-loaded");
    assert.ok(r !== null, "should resolve after successful auto-load");
    assert.equal(r!.modelKey, "ghost/not-loaded");
    assert.equal(r!.source, "preference");
  });

  test("returns null when preferred not loaded and auto-load fails", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("qwen/available-model")],
      getPrefs: async () => makePrefs({ extractorModel: "ghost/not-loaded" }),
      autoLoad: async () => false,
    });
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.equal(r, null, "must return null when auto-load fails (no silent substitution)");
  });

  test("v1.0.7 passive=true: does NOT trigger auto-load even if preferred model is not loaded", async () => {
    let autoLoadCalls = 0;
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("qwen/something-else")],
      getPrefs: async () => makePrefs({ extractorModel: "ghost/not-loaded" }),
      autoLoad: async () => { autoLoadCalls += 1; return true; },
    });
    const r = await modelRoleResolver.resolve("crystallizer", { passive: true });
    assert.equal(r, null, "passive resolve must return null instead of triggering load");
    assert.equal(autoLoadCalls, 0, "passive resolve must NOT call autoLoad even once");
  });

  test("v1.0.7 passive=false (default): triggers auto-load as before", async () => {
    let autoLoadCalls = 0;
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("qwen/something-else")],
      getPrefs: async () => makePrefs({ extractorModel: "ghost/not-loaded" }),
      autoLoad: async () => { autoLoadCalls += 1; return true; },
    });
    /* Default behavior: caller didn't pass {passive: true} → auto-load OK. */
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.equal(autoLoadCalls, 1, "non-passive resolve must call autoLoad exactly once");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "ghost/not-loaded");
  });

  test("v1.0.7 passive=true: returns CSV fallback when one IS loaded (no autoLoad needed)", async () => {
    let autoLoadCalls = 0;
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("fb/already-loaded")],
      getPrefs: async () => makePrefs({
        extractorModel: "ghost/not-loaded",
        extractorModelFallbacks: "fb/already-loaded",
      }),
      autoLoad: async () => { autoLoadCalls += 1; return true; },
    });
    const r = await modelRoleResolver.resolve("crystallizer", { passive: true });
    assert.equal(autoLoadCalls, 0, "CSV fallback hit means no autoLoad needed");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, "fb/already-loaded");
    assert.equal(r!.source, "fallback_list");
  });

  test("v1.0.7 passive=true: null cache is NOT poisoned — next non-passive call can still autoLoad", async () => {
    let autoLoadCalls = 0;
    _setResolverDepsForTests({
      listLoaded: async () => [],
      getPrefs: async () => makePrefs({
        extractorModel: "ghost/not-loaded",
        modelRoleCacheTtlMs: 60_000,
      }),
      autoLoad: async () => { autoLoadCalls += 1; return true; },
    });
    /* 1st call: passive — returns null without autoLoad, MUST NOT cache null. */
    const r1 = await modelRoleResolver.resolve("crystallizer", { passive: true });
    assert.equal(r1, null);
    assert.equal(autoLoadCalls, 0);

    /* 2nd call: active — should re-resolve and trigger autoLoad. If passive
       null had been cached, this would also return null. */
    const r2 = await modelRoleResolver.resolve("crystallizer");
    assert.equal(autoLoadCalls, 1, "non-passive call must NOT see stale null from passive cache");
    assert.ok(r2 !== null);
    assert.equal(r2!.modelKey, "ghost/not-loaded");
  });

  test("falls back to CSV fallback even when preferred not loaded", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("fb/model")],
      getPrefs: async () => makePrefs({
        extractorModel: "ghost/not-loaded",
        extractorModelFallbacks: "also-ghost,fb/model",
      }),
    });
    const r = await modelRoleResolver.resolve("crystallizer");
    assert.ok(r !== null, "CSV fallback should still work");
    assert.equal(r!.modelKey, "fb/model");
    assert.equal(r!.source, "fallback_list");
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

  test("uses role-specific fallback lists for evaluator, crystallizer, and vision_ocr", async () => {
    const cases: Array<{ role: ModelRole; pref: Partial<Preferences>; modelKey: string; caps?: Partial<LoadedModelInfo> }> = [
      { role: "evaluator", pref: { evaluatorModelFallbacks: "ghost,eval/fallback" }, modelKey: "eval/fallback" },
      { role: "crystallizer", pref: { extractorModelFallbacks: "ghost,extract/fallback" }, modelKey: "extract/fallback" },
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
  test("vision_ocr only considers models with vision=true", async () => {
    const textOnly = makeModel("text/only", { vision: false });
    const visionModel = makeModel("qwen/qwen3-vl", { vision: true });
    _setResolverDepsForTests({
      listLoaded: async () => [textOnly, visionModel],
      getPrefs: async () => makePrefs({}),
    });
    const r = await modelRoleResolver.resolve("vision_ocr");
    assert.ok(r !== null);
    assert.equal(r!.modelKey, visionModel.modelKey, "must pick vision-capable model");
  });

  test("vision_ocr returns null when no vision-capable model loaded", async () => {
    _setResolverDepsForTests({
      listLoaded: async () => [makeModel("text/only", { vision: false }), makeModel("another/text", { vision: false })],
      getPrefs: async () => makePrefs({}),
    });
    const r = await modelRoleResolver.resolve("vision_ocr");
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

/* ── v1.0.12 BUG-FIX: PASSIVE_SKIP rate-limit unit tests ────────────── */

import {
  _resetPassiveSkipRateLimitForTesting,
  _shouldLogPassiveSkipForTesting,
  _PASSIVE_SKIP_RATE_LIMIT_MS_FOR_TESTING,
} from "../electron/lib/llm/model-role-resolver.ts";

describe("[model-role-resolver] PASSIVE_SKIP rate-limit (v1.0.11)", () => {
  beforeEach(() => {
    _resetPassiveSkipRateLimitForTesting();
  });

  test("первый вызов для нового (role+model) → возвращает true (логируем)", () => {
    const result = _shouldLogPassiveSkipForTesting("crystallizer", "qwen/test-model");
    assert.equal(result, true, "первый вызов должен разрешить логирование");
  });

  test("повторный вызов в окне rate-limit → возвращает false (rate-limited)", () => {
    _shouldLogPassiveSkipForTesting("crystallizer", "qwen/test-model"); /* первый — true */
    const second = _shouldLogPassiveSkipForTesting("crystallizer", "qwen/test-model");
    assert.equal(second, false, "повторный вызов в окне 10 минут должен быть rate-limited");
  });

  test("разные роли — независимые ключи (rate-limit per role+model)", () => {
    _shouldLogPassiveSkipForTesting("crystallizer", "qwen/test-model"); /* лог 1 */
    const otherRole = _shouldLogPassiveSkipForTesting("evaluator", "qwen/test-model");
    assert.equal(otherRole, true, "другая роль = другой ключ → логируем");
  });

  test("разные модели — независимые ключи", () => {
    _shouldLogPassiveSkipForTesting("crystallizer", "qwen/model-A");
    const otherModel = _shouldLogPassiveSkipForTesting("crystallizer", "qwen/model-B");
    assert.equal(otherModel, true, "другая модель = другой ключ → логируем");
  });

  test("100 быстрых вызовов подряд → только 1 разрешённый лог (защита от spam)", () => {
    const SPAM_COUNT = 100;
    let allowedCount = 0;
    for (let i = 0; i < SPAM_COUNT; i++) {
      if (_shouldLogPassiveSkipForTesting("crystallizer", "qwen/spammed-model")) {
        allowedCount++;
      }
    }
    assert.equal(
      allowedCount,
      1,
      `из ${SPAM_COUNT} попыток rate-limit должен пропустить только 1 (фактически: ${allowedCount})`,
    );
  });

  test("после reset — счётчик сбрасывается, новый вызов разрешён", () => {
    _shouldLogPassiveSkipForTesting("crystallizer", "qwen/test-model");
    _resetPassiveSkipRateLimitForTesting();
    const afterReset = _shouldLogPassiveSkipForTesting("crystallizer", "qwen/test-model");
    assert.equal(afterReset, true, "после reset тот же ключ снова разрешён");
  });

  test("rate-limit интервал = 10 минут (контракт API)", () => {
    assert.equal(
      _PASSIVE_SKIP_RATE_LIMIT_MS_FOR_TESTING,
      10 * 60 * 1000,
      "rate-limit окно должно быть 10 минут (контракт документирован в коде)",
    );
  });
});
