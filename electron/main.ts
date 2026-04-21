import { app, BrowserWindow } from "electron";
import * as path from "path";
import {
  registerAllIpcHandlers,
  abortAllBatches,
  abortAllIngests,
  abortAllDatasetV2,
  abortAllBookhunter,
  abortAllAgents,
} from "./ipc";
import { disposeClient } from "./lmstudio-client";
import {
  initResilienceLayer,
  coordinator,
  telemetry,
  configureFileLockDefaults,
} from "./lib/resilience";
import { initPreferencesStore } from "./lib/preferences/store.js";
import { registerDatasetPipeline } from "./finetune-state";
import { registerForgePipeline } from "./lib/forge";
import { initForgeStore } from "./lib/forge/state";
import { registerExtractionPipeline } from "./lib/dataset-v2/coordinator-pipeline";
import { startWatchdog, stopWatchdog, configureWatchdog } from "./lib/resilience/lmstudio-watchdog";
import { SHUTDOWN_FLUSH_TIMEOUT_MS } from "./lib/resilience/constants";

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 820;
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;
const BG_COLOR = "#050508";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: BG_COLOR,
    title: "Bibliary",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const dataDir = path.resolve("data");
    await initResilienceLayer({ dataDir });
    const prefsStore = initPreferencesStore(dataDir);
    await prefsStore.ensureDefaults();
    const prefs = await prefsStore.getAll();
    configureWatchdog({
      pollIntervalMs: prefs.healthPollIntervalMs,
      failThreshold: prefs.healthFailThreshold,
      livenessTimeoutMs: prefs.watchdogLivenessTimeoutMs,
    });
    configureFileLockDefaults({
      retries: prefs.lockRetries,
      stale: prefs.lockStaleMs,
    });
    /* Forge store must be initialised after resilience layer (uses
       checkpoint store) but before registerForgePipeline (registers it
       in coordinator). Keeping it in main.ts is what breaks the cycle
       resilience/bootstrap <-> forge/state. */
    initForgeStore(dataDir);
    registerDatasetPipeline();
    registerForgePipeline();
    /* Crystallizer (extraction) is now first-class in coordinator: when
       LM Studio goes offline the watchdog pauses it (= aborts in-flight
       LLM calls) symmetrically with dataset/forge. */
    registerExtractionPipeline();
    startWatchdog(() => mainWindow);
    registerAllIpcHandlers(() => mainWindow);
    createWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  let isQuitting = false;
  app.on("before-quit", (event) => {
    if (isQuitting) return;
    if (!coordinator.isAnyActive()) {
      stopWatchdog();
      abortAllBatches("app-quit");
      abortAllIngests("app-quit");
      abortAllDatasetV2("app-quit");
      abortAllBookhunter("app-quit");
      abortAllAgents("app-quit");
      disposeClient();
      return;
    }

    event.preventDefault();
    isQuitting = true;
    const startedAt = Date.now();
    const pendingIds = coordinator.listActive().map((b) => b.batchId);
    telemetry.logEvent({ type: "shutdown.flush.start", pendingBatches: pendingIds });

    void (async () => {
      let exitCode = 0;
      try {
        const result = await coordinator.flushAll(SHUTDOWN_FLUSH_TIMEOUT_MS);
        if (result.ok) {
          telemetry.logEvent({ type: "shutdown.flush.ok", durationMs: Date.now() - startedAt });
        } else {
          telemetry.logEvent({ type: "shutdown.flush.timeout", pendingBatches: result.pending });
          exitCode = 2;
        }
      } catch (e) {
        telemetry.logEvent({
          type: "shutdown.flush.error",
          error: e instanceof Error ? e.message : String(e),
        });
        exitCode = 3;
      } finally {
        try {
          stopWatchdog();
        } catch {
          // ignore
        }
        try {
          abortAllBatches("app-quit");
        } catch {
          // ignore
        }
        try {
          abortAllIngests("app-quit");
        } catch {
          // ignore
        }
        try {
          abortAllDatasetV2("app-quit");
        } catch {
          // ignore
        }
        try {
          abortAllBookhunter("app-quit");
        } catch {
          // ignore
        }
        try {
          abortAllAgents("app-quit");
        } catch {
          // ignore
        }
        try {
          disposeClient();
        } catch {
          // ignore
        }
        await telemetry.flush().catch(() => undefined);
        app.exit(exitCode);
      }
    })();
  });
}
