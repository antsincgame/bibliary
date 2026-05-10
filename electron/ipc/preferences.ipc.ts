import { promises as fs } from "fs";
import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  getPreferencesStore,
  DEFAULTS,
  type Preferences,
} from "../lib/preferences/store.js";
import { configureWatchdog } from "../lib/resilience/lmstudio-watchdog.js";
import { configureFileLockDefaults } from "../lib/resilience/index.js";
import { invalidateEndpointsCache } from "../lib/endpoints/index.js";
import { refreshLmStudioClient } from "../lmstudio-client.js";
import { syncMarkerEnvFromPrefs } from "../lib/library/marker-sidecar.js";
import { applyImportSchedulerPrefs } from "../lib/library/import-task-scheduler.js";
import { applyEvaluatorPrefs } from "../lib/library/evaluator-queue.js";
import { applyHeavyLaneRateLimiterPrefs } from "../lib/llm/heavy-lane-rate-limiter.js";
import {
  preferencesGetAll,
  preferencesGetDefaults,
  preferencesSet,
  preferencesReset,
  preferencesGetProfile,
  preferencesExportProfile,
  preferencesImportProfile,
  preferencesApplyProfile,
  type PreferencesIpcDeps,
} from "./handlers/preferences.handlers.js";

/**
 * Apply preference values that affect already-running services. The
 * preferences file write happens earlier (atomic + locked); this only
 * pushes the new numbers into in-memory configuration of long-lived
 * runtime modules (watchdog timing, file-lock defaults, endpoint cache, ...).
 *
 * Exported (Иt 8Б): main.ts вызывает после initPreferencesStore чтобы
 * Settings-driven singletons получили актуальные лимиты на старте, а не
 * ждали первого `preferences:set`.
 */
export function applyRuntimeSideEffects(prefs: Preferences): void {
  configureWatchdog({
    pollIntervalMs: prefs.healthPollIntervalMs,
    failThreshold: prefs.healthFailThreshold,
    livenessTimeoutMs: prefs.watchdogLivenessTimeoutMs,
  });
  configureFileLockDefaults({
    retries: prefs.lockRetries,
    stale: prefs.lockStaleMs,
  });
  /* LM Studio URL changes: invalidate endpoints cache + drop cached SDK
     client so следующий вызов пересоздаёт против нового URL. vectordb URL
     ушёл — vector store теперь in-process LanceDB, нет HTTP binding'а
     для refresh'а. */
  invalidateEndpointsCache();
  refreshLmStudioClient();
  /* Sync Marker feature flag to ENV so marker-sidecar.ts can read it
     synchronously without an async preferences store dependency. */
  syncMarkerEnvFromPrefs(prefs.useMarkerExtractor);
  /* Smart Import Pipeline: Settings = single source of truth.
     applyRuntimeSideEffects распространяет изменения на живые singletons.
     parserPoolSize / illustrationParallelism / converterCacheMaxBytes /
     preferDjvuOverPdf читаются из prefs lazy по месту использования
     (не нужен push).
     Phase A+B Iter 9.6 (rev. 2): calibrePathOverride удалён — Calibre
     больше не используется в импорт-pipeline. */
  applyImportSchedulerPrefs({
    schedulerLightConcurrency: prefs.schedulerLightConcurrency,
    schedulerMediumConcurrency: prefs.schedulerMediumConcurrency,
    schedulerHeavyConcurrency: prefs.schedulerHeavyConcurrency,
  });
  applyEvaluatorPrefs({ evaluatorSlots: prefs.evaluatorSlots });
  applyHeavyLaneRateLimiterPrefs({ visionOcrRpm: prefs.visionOcrRpm });
  /* refactor 1.0.22: illustration feature удалён. */
}

export function registerPreferencesIpc(): void {
  function broadcastChanged(prefs: Preferences): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("preferences:changed", prefs);
      }
    }
  }

  /* Production deps: реальный preferences store + electron dialog + fs. */
  const deps: PreferencesIpcDeps = {
    getAllPrefs: () => getPreferencesStore().getAll(),
    getDefaults: () => DEFAULTS,
    setPrefs: (partial) => getPreferencesStore().set(partial),
    resetPrefs: () => getPreferencesStore().reset(),
    applyRuntimeSideEffects,
    broadcast: broadcastChanged,
    writeFile: (path, content, encoding) => fs.writeFile(path, content, encoding),
    readFile: (path, encoding) => fs.readFile(path, encoding),
  };

  ipcMain.handle("preferences:get-all", async () => preferencesGetAll(deps));
  ipcMain.handle("preferences:get-defaults", () => preferencesGetDefaults(deps));
  ipcMain.handle("preferences:set", async (_e, partial) => preferencesSet(deps, partial));
  ipcMain.handle("preferences:reset", async () => preferencesReset(deps));
  ipcMain.handle("preferences:get-profile", async () => preferencesGetProfile(deps));

  /* Dialog-handlers нуждаются в активном BrowserWindow для модальности —
     wrapper отдельно вычисляет окно и пробрасывает в deps.showSaveDialog. */
  ipcMain.handle("preferences:export-profile", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const showSaveDialog: PreferencesIpcDeps["showSaveDialog"] = (opts) =>
      win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts);
    return preferencesExportProfile({ ...deps, showSaveDialog });
  });

  ipcMain.handle("preferences:import-profile", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const showOpenDialog: PreferencesIpcDeps["showOpenDialog"] = (opts) =>
      win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
    return preferencesImportProfile({ ...deps, showOpenDialog });
  });

  ipcMain.handle("preferences:apply-profile", async (_e, payload) =>
    preferencesApplyProfile(deps, payload),
  );
}
