import { BrowserWindow, ipcMain } from "electron";
import { getPreferencesStore, DEFAULTS, type Preferences } from "../lib/preferences/store.js";
import { configureWatchdog } from "../lib/resilience/lmstudio-watchdog.js";
import { configureFileLockDefaults } from "../lib/resilience/index.js";
import { invalidateEndpointsCache, getEndpoints } from "../lib/endpoints/index.js";
import { setQdrantUrl } from "../lib/qdrant/http-client.js";
import { refreshLmStudioClient } from "../lmstudio-client.js";
import { syncMarkerEnvFromPrefs } from "../lib/library/marker-sidecar.js";
import { restartScheduler as restartArenaScheduler } from "../lib/llm/arena/scheduler.js";
import { modelRoleResolver } from "../lib/llm/model-role-resolver.js";

/**
 * Apply preference values that affect already-running services. The
 * preferences file write happens earlier (atomic + locked); this only
 * pushes the new numbers into in-memory configuration of long-lived
 * runtime modules (watchdog timing, file-lock defaults, endpoint cache, ...).
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
  /* URL changes: invalidate the endpoint cache, then refresh the live
     binding in qdrant/http-client and drop the cached LM Studio SDK
     client so the next call rebuilds against the new URL. */
  invalidateEndpointsCache();
  void getEndpoints().then(({ qdrantUrl }) => setQdrantUrl(qdrantUrl));
  refreshLmStudioClient();
  /* Sync Marker feature flag to ENV so marker-sidecar.ts can read it
     synchronously without an async preferences store dependency. */
  syncMarkerEnvFromPrefs(prefs.useMarkerExtractor);
  /* Reactive arena scheduler restart: changes to arenaEnabled /
     arenaCycleIntervalMs / arenaUseLlmJudge take effect immediately
     without waiting for app restart. */
  void restartArenaScheduler();
  /* Role resolver caches resolved models for `modelRoleCacheTtlMs` —
     invalidate now so changes to chatModel/agentModel/visionModelKey/
     fallbacks/arena-judge-key are visible on next IPC call. */
  modelRoleResolver.invalidate();
}

export function registerPreferencesIpc(): void {
  function broadcastChanged(prefs: Preferences): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("preferences:changed", prefs);
      }
    }
  }

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
    broadcastChanged(next);
    return next;
  });

  ipcMain.handle("preferences:reset", async (): Promise<Preferences> => {
    const next = await getPreferencesStore().reset();
    applyRuntimeSideEffects(next);
    broadcastChanged(next);
    return next;
  });
}
