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

import { BrowserWindow, ipcMain } from "electron";
import { readRatingsFile, resetRatings } from "../lib/llm/arena/ratings-store.js";
import { runArenaCycle, getChatRatings, type CycleOptions } from "../lib/llm/arena/run-cycle.js";
import { getPreferencesStore, type Preferences } from "../lib/preferences/store.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import { modelRoleResolver } from "../lib/llm/model-role-resolver.js";
import { restartScheduler } from "../lib/llm/arena/scheduler.js";
import { filterArenaConfigPatch, parseRunCycleOptions, pickArenaConfig, type ArenaConfig } from "./arena-ipc-helpers.js";

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
      chat: getChatRatings(f.roles), /* backward-compat для старого UI */
      lastCycleAt: f.lastCycleAt,
      lastError: f.lastError,
    };
  });

  ipcMain.handle("arena:run-cycle", async (_e, payload: unknown) => {
    const opts: CycleOptions = parseRunCycleOptions(payload);
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
    const filtered: Partial<Preferences> = filterArenaConfigPatch(partial);
    await getPreferencesStore().set(filtered);
    /* Применяем runtime-эффекты: scheduler реагирует на arenaEnabled / interval,
       resolver инвалидирует кэш если сменился arenaJudgeModelKey. */
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
