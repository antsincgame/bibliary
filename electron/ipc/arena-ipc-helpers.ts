import type { CycleOptions } from "../lib/llm/arena/run-cycle.js";
import type { ModelRole } from "../lib/llm/model-role-resolver.js";
import type { Preferences } from "../lib/preferences/store.js";

const VALID_ROLES: ReadonlyArray<ModelRole> = [
  "chat", "agent", "crystallizer", "judge",
  "vision_meta", "vision_ocr", "evaluator", "arena_judge",
];

export const ARENA_CONFIG_KEYS = [
  "arenaEnabled",
  "arenaUseLlmJudge",
  "arenaAutoPromoteWinner",
  "arenaMatchPairsPerCycle",
  "arenaCycleIntervalMs",
  "arenaJudgeModelKey",
] as const;

export interface ArenaConfig {
  arenaEnabled: boolean;
  arenaUseLlmJudge: boolean;
  arenaAutoPromoteWinner: boolean;
  arenaMatchPairsPerCycle: number;
  arenaCycleIntervalMs: number;
  arenaJudgeModelKey: string;
}

export function pickArenaConfig(prefs: Preferences): ArenaConfig {
  return {
    arenaEnabled: prefs.arenaEnabled,
    arenaUseLlmJudge: prefs.arenaUseLlmJudge,
    arenaAutoPromoteWinner: prefs.arenaAutoPromoteWinner,
    arenaMatchPairsPerCycle: prefs.arenaMatchPairsPerCycle,
    arenaCycleIntervalMs: prefs.arenaCycleIntervalMs,
    arenaJudgeModelKey: prefs.arenaJudgeModelKey,
  };
}

export function sanitizeRolesArg(input: unknown): ModelRole[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const valid = input.filter((x): x is ModelRole =>
    typeof x === "string" && (VALID_ROLES as readonly string[]).includes(x)
  );
  return valid.length > 0 ? valid : undefined;
}

export function parseRunCycleOptions(payload: unknown): CycleOptions {
  const opts: CycleOptions = {};
  if (!payload || typeof payload !== "object") return opts;
  const p = payload as Record<string, unknown>;
  const roles = sanitizeRolesArg(p.roles);
  if (roles) opts.roles = roles;
  if (p.bypassLock === true) opts.bypassLock = true;
  if (p.manual === true) opts.manual = true;
  return opts;
}

export function filterArenaConfigPatch(partial: unknown): Partial<Preferences> {
  if (!partial || typeof partial !== "object") {
    throw new Error("arena:set-config expects an object");
  }
  const filtered: Partial<Preferences> = {};
  const obj = partial as Record<string, unknown>;
  for (const key of ARENA_CONFIG_KEYS) {
    if (key in obj) {
      (filtered as Record<string, unknown>)[key] = obj[key];
    }
  }
  return filtered;
}
