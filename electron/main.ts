import { app, BrowserWindow, session, type OnHeadersReceivedListenerDetails } from "electron";
import * as path from "path";
import {
  registerAllIpcHandlers,
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

/**
 * Defense-in-depth Content Security Policy. The renderer is fully
 * trusted (we ship its HTML/JS), but we still pin a strict CSP so
 * that ANY future XSS via a stored Markdown payload, HF model
 * description, or PDF text cannot escalate into network/script abuse.
 *
 * Allowed:
 *   - script: self only (no inline, no eval -- preload exposes the
 *     entire IPC surface so renderer never needs to assemble code)
 *   - style:  self + Google Fonts CSS + 'unsafe-inline' (renderer
 *     uses inline `style="..."` in a few sacred-card / progress-bar
 *     spots; switching to attribute-only would mean a UI rewrite)
 *   - font:   self + Google Fonts
 *   - img:    self + data: (icons embedded as base64) + https: (book
 *     covers from BookHunter sources)
 *   - connect: self + Google Fonts + http(s):// localhost (LM Studio,
 *     Qdrant) + http(s)://* for HF / BookHunter sources
 */
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com http://localhost:* http://127.0.0.1:* https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived(
    (details: OnHeadersReceivedListenerDetails, callback) => {
      const headers = { ...(details.responseHeaders ?? {}) };
      headers["Content-Security-Policy"] = [CSP_HEADER];
      callback({ responseHeaders: headers });
    }
  );
}

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
      sandbox: false /* preload uses Node fs in a few spots; keeping
                       sandbox off until the migration to a thin
                       contextBridge-only preload is complete */,
      webSecurity: true,
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
    /* Resolve endpoints from preferences once and propagate the result
       into the live QDRANT_URL binding. Without this, modules that
       import { QDRANT_URL } at module-init read the env-only value. */
    const { setQdrantUrl } = await import("./lib/qdrant/http-client.js");
    const { getEndpoints } = await import("./lib/endpoints/index.js");
    const endpoints = await getEndpoints();
    setQdrantUrl(endpoints.qdrantUrl);

    registerForgePipeline();
    /* Crystallizer (extraction) is now first-class in coordinator: when
       LM Studio goes offline the watchdog pauses it (= aborts in-flight
       LLM calls) symmetrically with dataset/forge. */
    registerExtractionPipeline();
    applyCsp();
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
