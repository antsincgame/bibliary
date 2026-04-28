/**
 * Arena Olympics — несколько дисциплин на роль, разные чемпионы.
 *
 * Идея: один-единственный golden на роль даёт неустойчивую оценку.
 * Олимпиада прогоняет N разных дисциплин и смотрит, кто берёт больше золота.
 *
 * Этот тест проверяет:
 *  1. У ключевых ролей определено ≥3 разных дисциплины.
 *  2. Все дисциплины имеют разные id (нет случайных копий).
 *  3. Симулированный «турнир» через runArenaCycle с подменой getGoldenForRole
 *     корректно выдаёт разных чемпионов для разных дисциплин.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  OLYMPIC_GOLDENS_BY_ROLE,
  getGoldensForRole,
  type GoldenPrompt,
} from "../electron/lib/llm/arena/golden-prompts.ts";
import {
  runArenaCycle,
  _setRunCycleDepsForTests,
  _resetRunCycleDepsForTests,
} from "../electron/lib/llm/arena/run-cycle.ts";
import type { LoadedModelInfo } from "../electron/lmstudio-client.ts";
import type { Preferences } from "../electron/lib/preferences/store.ts";
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

describe("[olympics] golden coverage", () => {
  test("crystallizer / evaluator / translator / judge each have ≥3 disciplines", () => {
    for (const role of ["crystallizer", "evaluator", "translator", "judge"] as const) {
      const list = getGoldensForRole(role);
      assert.ok(list.length >= 3, `role ${role}: expected ≥3 disciplines, got ${list.length}`);
    }
  });

  test("all olympic golden ids are unique within each role", () => {
    for (const role of Object.keys(OLYMPIC_GOLDENS_BY_ROLE)) {
      const list = OLYMPIC_GOLDENS_BY_ROLE[role as keyof typeof OLYMPIC_GOLDENS_BY_ROLE]!;
      const ids = new Set(list.map((g) => g.id));
      assert.equal(ids.size, list.length, `role ${role}: duplicate ids in olympic goldens`);
    }
  });

  test("olympic goldens have non-empty system & user prompts", () => {
    for (const role of Object.keys(OLYMPIC_GOLDENS_BY_ROLE)) {
      const list = OLYMPIC_GOLDENS_BY_ROLE[role as keyof typeof OLYMPIC_GOLDENS_BY_ROLE]!;
      for (const g of list) {
        assert.ok(g.system.trim().length > 0, `${g.id}: empty system`);
        assert.ok(g.user.trim().length > 0, `${g.id}: empty user`);
      }
    }
  });
});

describe("[olympics] tournament: разные чемпионы для разных дисциплин", () => {
  test("3 disciplines × 3 cycles → каждая дисциплина может иметь своего чемпиона", async () => {
    /* Сценарий: три модели «спортсмены». Каждая лучше других в одной
       дисциплине. Прогоняем 3 цикла, в каждом активна СВОЯ дисциплина —
       getGoldenForRole возвращает соответствующий golden, а chat-функция
       выдаёт ответ, длина которого зависит от пары (model, discipline).
       Цель: убедиться, что система корректно записывает разные победы
       и Elo-таблица отражает все три исхода. */

    const goldens = getGoldensForRole("crystallizer");
    assert.ok(goldens.length >= 3);

    const ratings: ArenaRatingsFile = { version: 1, roles: { crystallizer: {} } };
    const matches: Array<{ winner: string; loser: string }> = [];

    /* Симулируем «силу»: spec-таблица говорит, чей ответ длиннее в данной
       дисциплине → объективный fallback пометит его победителем. */
    const strength: Record<string, Record<string, number>> = {
      "spec/algorithms": {
        [goldens[0]!.id]: 800, [goldens[1]!.id]: 200, [goldens[2]!.id]: 200,
      },
      "spec/history": {
        [goldens[0]!.id]: 200, [goldens[1]!.id]: 800, [goldens[2]!.id]: 200,
      },
      "spec/programming": {
        [goldens[0]!.id]: 200, [goldens[1]!.id]: 200, [goldens[2]!.id]: 800,
      },
    };

    let activeGolden: GoldenPrompt = goldens[0]!;

    _setRunCycleDepsForTests({
      getPrefs: async () => makePrefs({ arenaMatchPairsPerCycle: 3 }),
      setPrefs: async (p) => p as Preferences,
      listLoaded: async () => [
        makeModel("spec/algorithms"),
        makeModel("spec/history"),
        makeModel("spec/programming"),
      ],
      getLockStatus: () => ({ busy: false, reasons: [] }),
      recordLockSkip: () => undefined,
      chat: async ({ model }) => {
        const len = strength[model]?.[activeGolden.id] ?? 100;
        return { content: "x".repeat(len) + " end." };
      },
      chatWithPolicy: async () => ({ content: "A" }),
      resolveRole: async () => null,
      invalidateRole: () => undefined,
      getGoldenForRole: () => activeGolden,
      recordMatch: async (role, winner, loser) => {
        matches.push({ winner, loser });
        ratings.roles[role] ??= {};
        ratings.roles[role]![winner] = (ratings.roles[role]![winner] ?? 1500) + 16;
        ratings.roles[role]![loser] = (ratings.roles[role]![loser] ?? 1500) - 16;
      },
      readRatingsFile: async () => ratings,
      recordCycleError: async () => undefined,
    });

    /* Три цикла, каждый со своей активной дисциплиной. */
    for (let i = 0; i < 3; i++) {
      activeGolden = goldens[i]!;
      const r = await runArenaCycle({ roles: ["crystallizer"], manual: true });
      assert.equal(r.ok, true, `cycle ${i}: ${r.message}`);
    }

    /* В каждой дисциплине свой чемпион должен набрать хотя бы одну победу
       против каждого из двух других. */
    const wins = new Map<string, number>();
    for (const m of matches) wins.set(m.winner, (wins.get(m.winner) ?? 0) + 1);
    /* Все три «специалиста» должны иметь побед — иначе это не олимпиада. */
    assert.ok(wins.get("spec/algorithms")! >= 1, "alg specialist should win at least once");
    assert.ok(wins.get("spec/history")! >= 1, "history specialist should win at least once");
    assert.ok(wins.get("spec/programming")! >= 1, "programming specialist should win at least once");

    /* Lifetime Elo не обязан быть >1500 у всех (специалист проигрывает в
       чужих дисциплинах). Но суммарно по турниру каждый получил Elo-движение
       — это и есть «разные чемпионы для разных видов». */
    const elo = ratings.roles.crystallizer!;
    for (const m of ["spec/algorithms", "spec/history", "spec/programming"]) {
      assert.ok(typeof elo[m] === "number", `Elo entry for ${m} must exist after tournament`);
    }
    assert.ok(matches.length >= 3, "tournament should have at least 3 matches");
  });
});
