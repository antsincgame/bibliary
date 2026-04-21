import { ipcMain } from "electron";
import { getPreferencesStore, DEFAULTS, type Preferences } from "../lib/preferences/store.js";
import { configureWatchdog } from "../lib/resilience/lmstudio-watchdog.js";
import { configureFileLockDefaults } from "../lib/resilience/index.js";

/**
 * Apply preference values that affect already-running services. The
 * preferences file write happens earlier (atomic + locked); this only
 * pushes the new numbers into in-memory configuration of long-lived
 * runtime modules (watchdog timing, file-lock defaults, ...).
 */
function applyRuntimeSideEffects(prefs: Preferences): void {
  configureWatchdog({
    pollIntervalMs: prefs.healthPollIntervalMs,
    failThreshold: prefs.healthFailThreshold,
    livenessTimeoutMs: prefs.watchdogLivenessTimeoutMs,
  });
  configureFileLockDefaults({
    retries: prefs.lockRetries,
    stale: prefs.lockStaleMs,
  });
}

export function registerPreferencesIpc(): void {
  ipcMain.handle("preferences:get-all", async (): Promise<Preferences> => {
    return getPreferencesStore().getAll();
  });

  ipcMain.handle("preferences:get-defaults", (): Preferences => {
    return DEFAULTS;
  });

  ipcMain.handle("preferences:set", async (_e, partial: Partial<Preferences>): Promise<Preferences> => {
    if (!partial || typeof partial !== "object") throw new Error("Invalid preferences payload");
    const next = await getPreferencesStore().set(partial);
    applyRuntimeSideEffects(next);
    return next;
  });

  ipcMain.handle("preferences:reset", async (): Promise<Preferences> => {
    const next = await getPreferencesStore().reset();
    applyRuntimeSideEffects(next);
    return next;
  });
}
