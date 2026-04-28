/**
 * Arena E2E — реальный полный run-cycle, проверяет, что бои действительно
 * проводятся, judge получает оба ответа и leaderboard обновляется именно
 * победителем.
 *
 * Mock-уровень: LM Studio (chat/chatWithPolicy/listLoaded), prefs, ratings.
 * Реальная логика run-cycle проходит насквозь.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  runArenaCycle,
  _setRunCycleDepsForTests,
  _resetRunCycleDepsForTests,
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

beforeEach(() => _resetRunCycleDepsForTests());
afterEach(() => _resetRunCycleDepsForTests());

describe("[arena-e2e] precondition: loaded models", () => {
  test("0 loaded models → ok=false, clear message, no matches", async () => {
    const recorded: Array<{ role: ModelRole; winner: string; loser: string }> = [];
    _setRunCycleDepsForTests({
      getPrefs: async () => makePrefs(),
      setPrefs: async () => makePrefs(),
      listLoaded: async () => [],
      getLockStatus: () => ({ busy: false, reasons: [] }),
      recordLockSkip: () => undefined,
      chat: async () => { throw new Error("should not be called"); },
      chatWithPolicy: async () => { throw new Error("should not be called"); },
      resolveRole: async () => null,
      invalidateRole: () => undefined,
      getGoldenForRole: () => null,
      recordMatch: async (role, w, l) => { recorded.push({ role, winner: w, loser: l }); },
      readRatingsFile: async () => ({ version: 1, roles: {} } as ArenaRatingsFile),
      recordCycleError: async () => undefined,
    });

    const report = await runArenaCycle({ manual: true });
    assert.equal(report.ok, false);
    assert.match(report.message, /need at least 2 loaded LLM models/);
    assert.equal(recorded.length, 0);
  });

  test("1 loaded model → ok=false, no matches", async () => {
    let recordCount = 0;
    _setRunCycleDepsForTests({
      getPrefs: async () => makePrefs(),
      setPrefs: async () => makePrefs(),
      listLoaded: async () => [makeModel("only/one")],
      getLockStatus: () => ({ busy: false, reasons: [] }),
      recordLockSkip: () => undefined,
      chat: async () => ({ content: "x" }),
      chatWithPolicy: async () => ({ content: "A" }),
      resolveRole: async () => null,
      invalidateRole: () => undefined,
      getGoldenForRole: () => null,
      recordMatch: async () => { recordCount++; },
      readRatingsFile: async () => ({ version: 1, roles: {} } as ArenaRatingsFile),
      recordCycleError: async () => undefined,
    });

    const report = await runArenaCycle({ manual: true });
    assert.equal(report.ok, false);
    assert.match(report.message, /need at least 2/);
    assert.equal(recordCount, 0);
  });
});

describe("[arena-e2e] real fight with LLM judge", () => {
  test("two models battle, LLM judge picks winner, leaderboard reflects winner", async () => {
    const ratings: ArenaRatingsFile = { version: 1, roles: {} };
    const chatCalls: Array<{ model: string }> = [];
    const judgeCalls: Array<{ judge: string; promptHasA: boolean; promptHasB: boolean }> = [];
    const recorded: Array<{ role: ModelRole; winner: string; loser: string }> = [];

    _setRunCycleDepsForTests({
      getPrefs: async () => makePrefs({ arenaUseLlmJudge: true, arenaMatchPairsPerCycle: 1 }),
      setPrefs: async (p) => p as Preferences,
      listLoaded: async () => [
        makeModel("contestant/alpha"),
        makeModel("contestant/beta"),
      ],
      getLockStatus: () => ({ busy: false, reasons: [] }),
      recordLockSkip: () => undefined,
      chat: async ({ model }) => {
        chatCalls.push({ model });
        return { content: `Substantial answer from ${model}, with enough text to pass length filter.` };
      },
      chatWithPolicy: async ({ model, messages }) => {
        const prompt = messages.map((m) => m.content).join("\n");
        judgeCalls.push({
          judge: model,
          promptHasA: prompt.includes("contestant/alpha"),
          promptHasB: prompt.includes("contestant/beta"),
        });
        return { content: "B" };
      },
      resolveRole: async (role) => role === "judge"
        ? { modelKey: "official/judge", source: "preference" }
        : null,
      invalidateRole: () => undefined,
      getGoldenForRole: (role) => role === "crystallizer"
        ? { id: "g", role, system: "sys", user: "usr" }
        : null,
      recordMatch: async (role, winner, loser) => {
        recorded.push({ role, winner, loser });
        ratings.roles[role] ??= {};
        ratings.roles[role]![winner] = (ratings.roles[role]![winner] ?? 1500) + 16;
        ratings.roles[role]![loser] = (ratings.roles[role]![loser] ?? 1500) - 16;
      },
      readRatingsFile: async () => ratings,
      recordCycleError: async () => undefined,
    });

    const report = await runArenaCycle({ roles: ["crystallizer"], manual: true });

    assert.equal(report.ok, true);
    assert.equal(chatCalls.length, 2, "both contestants should be queried");
    assert.deepEqual(chatCalls.map((c) => c.model).sort(), ["contestant/alpha", "contestant/beta"]);

    assert.equal(judgeCalls.length, 1, "judge should be called exactly once");
    assert.equal(judgeCalls[0]!.judge, "official/judge");
    assert.equal(judgeCalls[0]!.promptHasA, true);
    assert.equal(judgeCalls[0]!.promptHasB, true);

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.winner, "contestant/beta", "judge said B → beta wins");
    assert.equal(recorded[0]!.loser, "contestant/alpha");

    const elo = ratings.roles.crystallizer!;
    assert.ok(elo["contestant/beta"]! > elo["contestant/alpha"]!, "winner Elo > loser Elo");
  });

  test("judge unavailable → falls back to objective comparison (length+latency)", async () => {
    let chatWithPolicyCalls = 0;
    const recorded: Array<{ winner: string; loser: string }> = [];

    _setRunCycleDepsForTests({
      getPrefs: async () => makePrefs({ arenaUseLlmJudge: true }),
      setPrefs: async (p) => p as Preferences,
      listLoaded: async () => [makeModel("a/long"), makeModel("b/short")],
      getLockStatus: () => ({ busy: false, reasons: [] }),
      recordLockSkip: () => undefined,
      chat: async ({ model }) => {
        if (model === "a/long") {
          return { content: "A".repeat(200) + " — long, well-substantiated reply." };
        }
        return { content: "B".repeat(200) + " — long, well-substantiated reply." };
      },
      chatWithPolicy: async () => { chatWithPolicyCalls++; return { content: "A" }; },
      resolveRole: async () => null,
      invalidateRole: () => undefined,
      getGoldenForRole: (role) => role === "crystallizer"
        ? { id: "g", role, system: "sys", user: "usr" }
        : null,
      recordMatch: async (_role, winner, loser) => { recorded.push({ winner, loser }); },
      readRatingsFile: async () => ({ version: 1, roles: {} }),
      recordCycleError: async () => undefined,
    });

    const report = await runArenaCycle({ roles: ["crystallizer"], manual: true });
    assert.equal(report.ok, true);
    assert.equal(chatWithPolicyCalls, 0, "judge model not resolved → no chatWithPolicy");
    assert.equal(recorded.length, 1, "objective fallback still records a match");
  });
});

describe("[arena-e2e] auto-promote winner", () => {
  test("when arenaAutoPromoteWinner=true, top Elo model is written to prefs", async () => {
    const ratings: ArenaRatingsFile = {
      version: 1,
      roles: {
        crystallizer: {
          "rocket/9000": 1700,
          "old/3000": 1450,
        },
      },
    };
    const prefs = makePrefs({
      arenaAutoPromoteWinner: true,
      extractorModel: "old/3000",
    });

    _setRunCycleDepsForTests({
      getPrefs: async () => prefs,
      setPrefs: async (partial) => { Object.assign(prefs, partial); return prefs; },
      listLoaded: async () => [makeModel("rocket/9000"), makeModel("old/3000")],
      getLockStatus: () => ({ busy: false, reasons: [] }),
      recordLockSkip: () => undefined,
      chat: async () => ({ content: "answer with enough length to be valid for objective scoring." }),
      chatWithPolicy: async () => ({ content: "A" }),
      resolveRole: async () => null,
      invalidateRole: () => undefined,
      getGoldenForRole: (role) => role === "crystallizer"
        ? { id: "g", role, system: "sys", user: "usr" }
        : null,
      recordMatch: async () => {},
      readRatingsFile: async () => ratings,
      recordCycleError: async () => undefined,
    });

    const report = await runArenaCycle({ roles: ["crystallizer"], manual: true });
    assert.equal(report.ok, true);
    const promoteHit = (report.perRole?.[0]?.results ?? []).some((s) => /auto-promoted rocket\/9000/.test(s));
    assert.ok(promoteHit, `expected auto-promotion log, got: ${JSON.stringify(report.perRole)}`);
    assert.equal(prefs.extractorModel, "rocket/9000");
  });
});

describe("[arena-e2e] translator role", () => {
  test("translator role is calibratable and gets a golden prompt", async () => {
    const recorded: Array<{ role: ModelRole; winner: string; loser: string }> = [];
    _setRunCycleDepsForTests({
      getPrefs: async () => makePrefs(),
      setPrefs: async (p) => p as Preferences,
      listLoaded: async () => [makeModel("translator/a"), makeModel("translator/b")],
      getLockStatus: () => ({ busy: false, reasons: [] }),
      recordLockSkip: () => undefined,
      chat: async () => ({ content: "Алгоритм поиска в глубину обходит дерево от корня." }),
      chatWithPolicy: async () => ({ content: "A" }),
      resolveRole: async () => null,
      invalidateRole: () => undefined,
      getGoldenForRole: (role) => role === "translator"
        ? { id: "g", role, system: "sys", user: "Алгоритм пошуку в глибину..." }
        : null,
      recordMatch: async (role, winner, loser) => { recorded.push({ role, winner, loser }); },
      readRatingsFile: async () => ({ version: 1, roles: {} }),
      recordCycleError: async () => undefined,
    });

    const report = await runArenaCycle({ roles: ["translator"], manual: true });
    assert.equal(report.ok, true);
    assert.equal(report.perRole?.[0]?.role, "translator");
    assert.equal(recorded.length, 1, "translator must record at least one match");
    assert.equal(recorded[0]!.role, "translator");
  });
});
