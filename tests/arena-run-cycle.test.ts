import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  runArenaCycle,
  _setRunCycleDepsForTests,
  _resetRunCycleDepsForTests,
  type CycleOptions,
} from "../electron/lib/llm/arena/run-cycle.ts";
import type { LoadedModelInfo } from "../electron/lmstudio-client.ts";
import type { Preferences } from "../electron/lib/preferences/store.ts";
import type { ModelRole } from "../electron/lib/llm/model-role-resolver.ts";
import type { ArenaRatingsFile } from "../electron/lib/llm/arena/ratings-store.ts";

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
    arenaEnabled: true,
    arenaUseLlmJudge: false,
    arenaAutoPromoteWinner: false,
    arenaMatchPairsPerCycle: 1,
    arenaCycleIntervalMs: 3_600_000,
    modelRoleCacheTtlMs: 0,
    ...overrides,
  } as unknown as Preferences;
}

function makeRatings(): ArenaRatingsFile {
  return { version: 1, roles: {} };
}

function installRunCycleHarness({
  prefs = makePrefs(),
  loaded = [makeModel("model/a"), makeModel("model/b")],
  lock = { busy: false, reasons: [] as string[] },
  onListLoaded,
}: {
  prefs?: Preferences;
  loaded?: LoadedModelInfo[];
  lock?: { busy: boolean; reasons: string[] };
  onListLoaded?: () => void;
} = {}): { ratings: ArenaRatingsFile; recordedMatches: Array<{ role: ModelRole; winner: string; loser: string }>; skipped: string[][] } {
  const ratings = makeRatings();
  const recordedMatches: Array<{ role: ModelRole; winner: string; loser: string }> = [];
  const skipped: string[][] = [];

  _setRunCycleDepsForTests({
    getPrefs: async () => prefs,
    setPrefs: async (partial) => Object.assign(prefs, partial),
    listLoaded: async () => {
      onListLoaded?.();
      return loaded;
    },
    getLockStatus: () => lock,
    recordLockSkip: (reasons) => skipped.push(reasons),
    chat: async () => ({ content: "This is a complete enough model answer for arena scoring." }),
    chatWithPolicy: async () => ({ content: "A" }),
    resolveRole: async () => ({ modelKey: "judge/model", source: "preference" }),
    invalidateRole: () => undefined,
    getGoldenForRole: (role) => ({
      id: `${role}-golden`,
      role,
      system: "system",
      user: "user",
    }),
    recordMatch: async (role, winner, loser) => {
      recordedMatches.push({ role, winner, loser });
      ratings.roles[role] ??= {};
      ratings.roles[role]![winner] = 1516;
      ratings.roles[role]![loser] = 1484;
    },
    readRatingsFile: async () => ratings,
    recordCycleError: async () => undefined,
  });

  return { ratings, recordedMatches, skipped };
}

beforeEach(() => {
  _resetRunCycleDepsForTests();
});

afterEach(() => {
  _resetRunCycleDepsForTests();
});

describe("[arena-run-cycle] cycle selection", () => {
  test("background cycle is skipped when arena is disabled", async () => {
    let listLoadedCalls = 0;
    installRunCycleHarness({ prefs: makePrefs({ arenaEnabled: false }), onListLoaded: () => { listLoadedCalls += 1; } });

    const report = await runArenaCycle();
    assert.equal(report.ok, true);
    assert.equal(report.message, "arena disabled");
    assert.equal(listLoadedCalls, 0, "disabled background run should not touch LM Studio");
  });

  test("manual run executes even when background arena is disabled", async () => {
    const harness = installRunCycleHarness({ prefs: makePrefs({ arenaEnabled: false }) });
    const report = await runArenaCycle({ roles: ["crystallizer"], manual: true });

    assert.equal(report.ok, true);
    assert.equal(report.perRole?.length, 1);
    assert.equal(report.perRole?.[0]?.role, "crystallizer");
    assert.equal(harness.recordedMatches.length, 1);
  });

  test("unsupported role subset returns no calibratable roles", async () => {
    installRunCycleHarness();
    const report = await runArenaCycle({ roles: ["vision_ocr"], manual: true });

    assert.equal(report.ok, false);
    assert.equal(report.message, "no calibratable roles in opts.roles");
  });
});

describe("[arena-run-cycle] lock and capability filtering", () => {
  test("busy GlobalLlmLock returns skipped report and records skip", async () => {
    const harness = installRunCycleHarness({ lock: { busy: true, reasons: ["library-import: active"] } });
    const report = await runArenaCycle({ roles: ["crystallizer"], manual: true });

    assert.equal(report.ok, false);
    assert.equal(report.skipped, true);
    assert.deepEqual(report.skipReasons, ["library-import: active"]);
    assert.deepEqual(harness.skipped, [["library-import: active"]]);
  });

  test("vision roles require two loaded vision-capable models", async () => {
    installRunCycleHarness({
      loaded: [
        makeModel("text/a", { vision: false }),
        makeModel("text/b", { vision: false }),
        makeModel("vision/only", { vision: true }),
      ],
    });

    const report = await runArenaCycle({ roles: ["vision_meta"], manual: true });
    assert.equal(report.ok, true);
    assert.equal(report.perRole?.[0]?.role, "vision_meta");
    assert.equal(report.perRole?.[0]?.matches, 0);
    assert.match(report.perRole?.[0]?.skipped ?? "", /need at least 2 eligible models/);
  });

  test("multi-role cycle updates Elo buckets per role", async () => {
    const harness = installRunCycleHarness();
    const opts: CycleOptions = { roles: ["crystallizer", "judge"], manual: true };
    const report = await runArenaCycle(opts);

    assert.equal(report.ok, true);
    assert.deepEqual(report.perRole?.map((r) => r.role), ["crystallizer", "judge"]);
    assert.equal(harness.recordedMatches.length, 2);
    assert.ok(harness.ratings.roles.crystallizer?.["model/a"]);
    assert.ok(harness.ratings.roles.judge?.["model/a"]);
  });
});
