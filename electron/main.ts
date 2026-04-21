import { app, BrowserWindow } from "electron";
import * as path from "path";
import {
  registerAllIpcHandlers,
  abortAllBatches,
  abortAllIngests,
  abortAllDatasetV2,
  abortAllBookhunter,
} from "./ipc";
import { disposeClient } from "./lmstudio-client";
import { initResilienceLayer, coordinator, telemetry } from "./lib/resilience";
import { registerDatasetPipeline } from "./finetune-state";
import { registerForgePipeline } from "./lib/forge";
import { startWatchdog, stopWatchdog } from "./lib/resilience/lmstudio-watchdog";
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
    await initResilienceLayer();
    registerDatasetPipeline();
    registerForgePipeline();
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
