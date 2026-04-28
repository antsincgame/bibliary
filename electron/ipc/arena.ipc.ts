/**
 * Arena IPC — model calibration through shadow Elo arena.
 */

import { BrowserWindow, ipcMain } from "electron";
import { readRatingsFile, resetRatings } from "../lib/llm/arena/ratings-store.js";
import { runArenaCycle, type CycleOptions } from "../lib/llm/arena/run-cycle.js";
import { getPreferencesStore, type Preferences } from "../lib/preferences/store.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import { modelRoleResolver, type ModelRole } from "../lib/llm/model-role-resolver.js";
import { restartScheduler } from "../lib/llm/arena/scheduler.js";

const VALID_ROLES: readonly string[] = [
  "crystallizer",
  "judge",
  "vision_meta",
  "vision_ocr",
  "evaluator",
  "ukrainian_specialist",
  "lang_detector",
  "translator",
];

const ARENA_CONFIG_KEYS = [
  "arenaEnabled",
  "arenaUseLlmJudge",
  "arenaAutoPromoteWinner",
  "arenaMatchPairsPerCycle",
  "arenaCycleIntervalMs",
] as const;

interface ArenaConfig {
  arenaEnabled: boolean;
  arenaUseLlmJudge: boolean;
  arenaAutoPromoteWinner: boolean;
  arenaMatchPairsPerCycle: number;
  arenaCycleIntervalMs: number;
}

function pickArenaConfig(prefs: Preferences): ArenaConfig {
  return {
    arenaEnabled: prefs.arenaEnabled,
    arenaUseLlmJudge: prefs.arenaUseLlmJudge,
    arenaAutoPromoteWinner: prefs.arenaAutoPromoteWinner,
    arenaMatchPairsPerCycle: prefs.arenaMatchPairsPerCycle,
    arenaCycleIntervalMs: prefs.arenaCycleIntervalMs,
  };
}

function sanitizeRolesArg(input: unknown): ModelRole[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const valid = input.filter((x): x is ModelRole =>
    typeof x === "string" && VALID_ROLES.includes(x),
  );
  return valid.length > 0 ? valid : undefined;
}

export function registerArenaIpc(): void {
  function broadcastPreferencesChanged(prefs: Preferences): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("preferences:changed", prefs);
      }
    }
  }

  ipcMain.handle("arena:get-ratings", async () => {
    const f = await readRatingsFile();
    return {
      roles: f.roles,
      lastCycleAt: f.lastCycleAt,
      lastError: f.lastError,
    };
  });

  ipcMain.handle("arena:run-cycle", async (_e, payload: unknown) => {
    const opts: CycleOptions = {};
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const roles = sanitizeRolesArg(p.roles);
      if (roles) opts.roles = roles;
      if (p.bypassLock === true) opts.bypassLock = true;
      if (p.manual === true) opts.manual = true;
    }
    return runArenaCycle(opts);
  });

  ipcMain.handle("arena:reset-ratings", async () => {
    await resetRatings();
    modelRoleResolver.invalidate();
    return readRatingsFile();
  });

  ipcMain.handle("arena:get-config", async (): Promise<ArenaConfig> => {
    const prefs = await getPreferencesStore().getAll();
    return pickArenaConfig(prefs);
  });

  ipcMain.handle("arena:set-config", async (_e, partial: unknown): Promise<ArenaConfig> => {
    if (!partial || typeof partial !== "object") throw new Error("arena:set-config expects an object");
    const filtered: Partial<Preferences> = {};
    const obj = partial as Record<string, unknown>;
    for (const key of ARENA_CONFIG_KEYS) {
      if (key in obj) (filtered as Record<string, unknown>)[key] = obj[key];
    }
    await getPreferencesStore().set(filtered);
    void restartScheduler();
    modelRoleResolver.invalidate();
    const prefs = await getPreferencesStore().getAll();
    broadcastPreferencesChanged(prefs);
    return pickArenaConfig(prefs);
  });

  ipcMain.handle("arena:get-lock-status", async () => {
    return globalLlmLock.getStatus();
  });
}
