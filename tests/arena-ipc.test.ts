import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ARENA_CONFIG_KEYS,
  filterArenaConfigPatch,
  parseRunCycleOptions,
  pickArenaConfig,
  sanitizeRolesArg,
} from "../electron/ipc/arena-ipc-helpers.ts";
import type { Preferences } from "../electron/lib/preferences/store.ts";

function makePrefs(overrides: Partial<Preferences> = {}): Preferences {
  return {
    arenaEnabled: true,
    arenaUseLlmJudge: false,
    arenaAutoPromoteWinner: false,
    arenaMatchPairsPerCycle: 3,
    arenaCycleIntervalMs: 3_600_000,
    arenaJudgeModelKey: "judge/model",
    ...overrides,
  } as unknown as Preferences;
}

describe("[arena-ipc] run-cycle payload parsing", () => {
  test("keeps only valid roles and boolean flags", () => {
    const opts = parseRunCycleOptions({
      roles: ["chat", "invalid", "vision_ocr", 42],
      bypassLock: true,
      manual: true,
    });

    assert.deepEqual(opts.roles, ["chat", "vision_ocr"]);
    assert.equal(opts.bypassLock, true);
    assert.equal(opts.manual, true);
  });

  test("returns empty options for invalid payload", () => {
    assert.deepEqual(parseRunCycleOptions(null), {});
    assert.deepEqual(parseRunCycleOptions("bad"), {});
    assert.equal(sanitizeRolesArg(["bad-role"]), undefined);
  });
});

describe("[arena-ipc] config payload shaping", () => {
  test("pickArenaConfig returns only public arena config fields", () => {
    const config = pickArenaConfig(makePrefs({ arenaMatchPairsPerCycle: 5 }));

    assert.deepEqual(Object.keys(config).sort(), [...ARENA_CONFIG_KEYS].sort());
    assert.equal(config.arenaEnabled, true);
    assert.equal(config.arenaMatchPairsPerCycle, 5);
    assert.equal(config.arenaJudgeModelKey, "judge/model");
  });

  test("filterArenaConfigPatch rejects non-objects and drops unknown keys", () => {
    assert.throws(() => filterArenaConfigPatch(null), /expects an object/);

    const patch = filterArenaConfigPatch({
      arenaEnabled: false,
      arenaUseLlmJudge: true,
      chatModel: "should-not-pass",
      unknown: "ignored",
    });

    assert.deepEqual(patch, {
      arenaEnabled: false,
      arenaUseLlmJudge: true,
    });
  });
});
