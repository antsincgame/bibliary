/**
 * Arena IPC — управление калибровкой моделей через shadow Elo arena.
 *
 * Каналы:
 *   arena:get-ratings    — Elo по всем ролям (и chat для backward-compat)
 *   arena:run-cycle      — запустить cycle (полный или по подмножеству ролей)
 *   arena:reset-ratings  — обнулить Elo
 *   arena:get-config     — чтение arena-настроек из preferences
 *   arena:set-config     — частичная запись arena-настроек
 *   arena:get-lock-status — состояние GlobalLlmLock (для UI индикатора)
 */

import { ipcMain } from "electron";
import { readRatingsFile, resetRatings } from "../lib/llm/arena/ratings-store.js";
import { runArenaCycle, getChatRatings, type CycleOptions } from "../lib/llm/arena/run-cycle.js";
import { getPreferencesStore, type Preferences } from "../lib/preferences/store.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import { modelRoleResolver, type ModelRole } from "../lib/llm/model-role-resolver.js";
import { restartScheduler } from "../lib/llm/arena/scheduler.js";

const VALID_ROLES: ReadonlyArray<ModelRole> = [
  "chat", "agent", "crystallizer", "judge",
  "vision_meta", "vision_ocr", "evaluator", "arena_judge",
];

export interface ArenaConfig {
  arenaEnabled: boolean;
  arenaUseLlmJudge: boolean;
  arenaAutoPromoteWinner: boolean;
  arenaMatchPairsPerCycle: number;
  arenaCycleIntervalMs: number;
  arenaJudgeModelKey: string;
}

function pickArenaConfig(prefs: Preferences): ArenaConfig {
  return {
    arenaEnabled: prefs.arenaEnabled,
    arenaUseLlmJudge: prefs.arenaUseLlmJudge,
    arenaAutoPromoteWinner: prefs.arenaAutoPromoteWinner,
    arenaMatchPairsPerCycle: prefs.arenaMatchPairsPerCycle,
    arenaCycleIntervalMs: prefs.arenaCycleIntervalMs,
    arenaJudgeModelKey: prefs.arenaJudgeModelKey,
  };
}

function sanitizeRolesArg(input: unknown): ModelRole[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const valid = input.filter((x): x is ModelRole =>
    typeof x === "string" && (VALID_ROLES as readonly string[]).includes(x)
  );
  return valid.length > 0 ? valid : undefined;
}

export function registerArenaIpc(): void {
  ipcMain.handle("arena:get-ratings", async () => {
    const f = await readRatingsFile();
    return {
      roles: f.roles,
      chat: getChatRatings(f.roles), /* backward-compat для старого UI */
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
    }
    return runArenaCycle(opts);
  });

  ipcMain.handle("arena:reset-ratings", async () => {
    await resetRatings();
    /* Сбрасываем кэш resolver'а — top-Elo источник теперь пустой. */
    modelRoleResolver.invalidate();
    return readRatingsFile();
  });

  ipcMain.handle("arena:get-config", async (): Promise<ArenaConfig> => {
    const prefs = await getPreferencesStore().getAll();
    return pickArenaConfig(prefs);
  });

  ipcMain.handle("arena:set-config", async (_e, partial: unknown): Promise<ArenaConfig> => {
    if (!partial || typeof partial !== "object") {
      throw new Error("arena:set-config expects an object");
    }
    const allowed = [
      "arenaEnabled",
      "arenaUseLlmJudge",
      "arenaAutoPromoteWinner",
      "arenaMatchPairsPerCycle",
      "arenaCycleIntervalMs",
      "arenaJudgeModelKey",
    ] as const;
    const filtered: Partial<Preferences> = {};
    const obj = partial as Record<string, unknown>;
    for (const key of allowed) {
      if (key in obj) {
        (filtered as Record<string, unknown>)[key] = obj[key];
      }
    }
    await getPreferencesStore().set(filtered);
    /* Применяем runtime-эффекты: scheduler реагирует на arenaEnabled / interval,
       resolver инвалидирует кэш если сменился arenaJudgeModelKey. */
    void restartScheduler();
    modelRoleResolver.invalidate();
    const prefs = await getPreferencesStore().getAll();
    return pickArenaConfig(prefs);
  });

  ipcMain.handle("arena:get-lock-status", async () => {
    return globalLlmLock.getStatus();
  });
}
