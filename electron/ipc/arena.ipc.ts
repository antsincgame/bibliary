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
import { runOlympics, type OlympicsReport, type OlympicsRole } from "../lib/llm/arena/olympics.js";

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

  /* ─── Олимпиада: реальный турнир локальных моделей через LM Studio ─── */

  let activeOlympicsCtrl: AbortController | null = null;

  ipcMain.handle("arena:run-olympics", async (e, payload: unknown): Promise<OlympicsReport> => {
    if (activeOlympicsCtrl) {
      throw new Error("Олимпиада уже идёт. Подожди или нажми «Отмена».");
    }
    const lock = globalLlmLock.isBusy();
    if (lock.busy) {
      globalLlmLock.recordSkip(lock.reasons);
      throw new Error(`LM Studio сейчас занята: ${lock.reasons.join("; ")}. Останови импорт/оценку и запусти Олимпиаду снова.`);
    }
    const args = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const ctrl = new AbortController();
    activeOlympicsCtrl = ctrl;
    const unregisterOlympicsProbe = globalLlmLock.registerProbe("olympics", () => ({
      busy: true,
      reason: "Olympics model calibration is running",
    }));

    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (channel: string, data: unknown): void => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, data);
    };

    try {
      const report = await runOlympics({
        models: Array.isArray(args.models) ? (args.models as string[]) : undefined,
        disciplines: Array.isArray(args.disciplines) ? (args.disciplines as string[]) : undefined,
        maxModels: typeof args.maxModels === "number" ? args.maxModels : undefined,
        weightClasses: Array.isArray(args.weightClasses) ? (args.weightClasses as Array<"xs"|"s"|"m"|"l"|"xl"|"unknown">) : undefined,
        testAll: args.testAll === true,
        roles: Array.isArray(args.roles) ? (args.roles as OlympicsRole[]) : undefined,
        signal: ctrl.signal,
        onProgress: (ev) => send("arena:olympics-progress", ev),
      });
      return report;
    } finally {
      unregisterOlympicsProbe();
      activeOlympicsCtrl = null;
    }
  });

  ipcMain.handle("arena:cancel-olympics", async (): Promise<boolean> => {
    if (!activeOlympicsCtrl) return false;
    activeOlympicsCtrl.abort();
    return true;
  });

  ipcMain.handle("arena:clear-olympics-cache", async () => {
    const { clearOlympicsCache } = await import("../lib/llm/arena/olympics.js");
    clearOlympicsCache();
    return { ok: true };
  });

  ipcMain.handle("arena:apply-olympics-recommendations", async (_e, payload: unknown): Promise<Preferences> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("apply-olympics-recommendations: ожидается объект {recommendations}");
    }
    const recs = (payload as { recommendations?: Record<string, string> }).recommendations;
    if (!recs || typeof recs !== "object") throw new Error("recommendations отсутствуют");

    /* Whitelist: только эти ключи разрешено применять. */
    const ALLOWED = new Set([
      "extractorModel", "judgeModel", "evaluatorModel", "translatorModel",
      "visionModelKey",
      "langDetectorModel", "ukrainianSpecialistModel",
    ]);
    const filtered: Partial<Preferences> = {};
    for (const [k, v] of Object.entries(recs)) {
      if (ALLOWED.has(k) && typeof v === "string" && v.trim().length > 0) {
        (filtered as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(filtered).length === 0) {
      throw new Error("Нет валидных рекомендаций для применения");
    }
    await getPreferencesStore().set(filtered);
    modelRoleResolver.invalidate();
    const prefs = await getPreferencesStore().getAll();
    broadcastPreferencesChanged(prefs);
    return prefs;
  });
}
