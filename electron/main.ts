import { app, BrowserWindow, session, protocol, net, type OnHeadersReceivedListenerDetails } from "electron";
import * as path from "path";
import { promises as fs } from "fs";
import {
  registerAllIpcHandlers,
  abortAllIngests,
  abortAllDatasetV2,
  abortAllBookhunter,
  abortAllAgents,
  abortAllForgeLocal,
  abortAllForgeEval,
  abortAllLibrary,
  activeLibraryImportCount,
  flushLibraryImports,
  bootstrapLibrarySubsystem,
} from "./ipc";
import { disposeClient } from "./lmstudio-client";
import { triggerAppShutdown } from "./lib/app-lifecycle.js";
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
import { getWindowsParentExecutablePath, resolveAppDataDir } from "./lib/app-data-dir.js";
import { closeCacheDb } from "./lib/library/cache-db.js";
import { killAllSynthChildren } from "./ipc/dataset-v2.ipc.js";
import { resolveBlobFromUrl, getBlobsRoot } from "./lib/library/library-store.js";
import { resolveLibraryRoot } from "./lib/library/paths.js";

process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
});

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
  "img-src 'self' data: https: bibliary-asset:",
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

function registerAssetProtocol(): void {
  protocol.handle("bibliary-asset", async (request) => {
    const url = request.url;
    const libraryRoot = resolveLibraryRoot();
    const resolved = await resolveBlobFromUrl(libraryRoot, url);
    if (!resolved) {
      return new Response("Not Found", { status: 404 });
    }
    const blobsBase = path.resolve(getBlobsRoot(libraryRoot));
    if (!path.resolve(resolved).startsWith(blobsBase)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(`file://${resolved}`);
  });
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

protocol.registerSchemesAsPrivileged([
  {
    scheme: "bibliary-asset",
    privileges: {
      standard: false,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: false,
      stream: true,
    },
  },
]);

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
    /* Allow tests / portable installs to point at a custom data directory.
       Default остаётся `data/` рядом с приложением -- это не меняет
       поведение для обычного пользователя, но даёт smoke-тесту полную
       изоляцию (свой preferences.json, свой forge state, своя SQLite). */
    const dataDir = resolveAppDataDir({
      env: process.env,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appName: app.getName(),
      devBaseDir: __dirname,
      platform: process.platform,
      parentExecutablePath: process.platform === "win32" ? getWindowsParentExecutablePath() : null,
    });
    process.env.BIBLIARY_DATA_DIR = dataDir;

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
    registerAssetProtocol();
    startWatchdog(() => mainWindow);
    registerAllIpcHandlers(() => mainWindow);
    /* Library subsystem: подписывает evaluator-queue на broadcast в renderer
       и запускает bootstrap (re-queue всех imported книг с прошлого раза).
       Не блокирует createWindow -- ошибка bootstrap не должна валить старт. */
    void bootstrapLibrarySubsystem(() => mainWindow);
    createWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  const FORCE_EXIT_MS = 4_000;

  function teardownSubsystems(): void {
    const subsystems: [string, () => void][] = [
      ["triggerAppShutdown", triggerAppShutdown],
      ["stopWatchdog", stopWatchdog],
      ["abortAllIngests", () => abortAllIngests("app-quit")],
      ["abortAllDatasetV2", () => abortAllDatasetV2("app-quit")],
      ["killAllSynthChildren", killAllSynthChildren],
      ["abortAllBookhunter", () => abortAllBookhunter("app-quit")],
      ["abortAllAgents", () => abortAllAgents("app-quit")],
      ["abortAllForgeLocal", () => abortAllForgeLocal("app-quit")],
      ["abortAllForgeEval", () => abortAllForgeEval("app-quit")],
      ["abortAllLibrary", () => abortAllLibrary("app-quit")],
      ["disposeClient", disposeClient],
      ["closeCacheDb", closeCacheDb],
    ];
    for (const [label, fn] of subsystems) {
      try { fn(); } catch (e) {
        console.error(`[main/shutdown] ${label} Error:`, e);
      }
    }
  }

  let isQuitting = false;
  app.on("before-quit", (event) => {
    if (isQuitting) return;

    const forceTimer = setTimeout(() => {
      console.error("[main/shutdown] force-exit after timeout");
      app.exit(0);
    }, FORCE_EXIT_MS);
    forceTimer.unref();

    /* CRITICAL: даже если coordinator пуст (нет extraction/forge), может идти
       library import — fs.writeFile / copyFile / cache-db upsert. Если выйти
       прямо сейчас, book.md останется полу-битым, SHA-кэш не сохранится.
       Дожидаемся abort + завершения активных импортов до закрытия БД. */
    const activeImports = activeLibraryImportCount();
    const idle = !coordinator.isAnyActive() && activeImports === 0;

    if (idle) {
      console.log("[main/shutdown] idle path — no active batches or imports");
      teardownSubsystems();
      telemetry.flush()
        .catch((err) => console.error("[main/shutdown] telemetry.flush Error:", err))
        .finally(() => {
          console.log("[main/shutdown] idle path — telemetry flushed, clearing force timer");
          clearTimeout(forceTimer);
        });
      return;
    }

    if (activeImports > 0) {
      console.log(`[main/shutdown] flush path — ${activeImports} active library imports`);
      event.preventDefault();
      isQuitting = true;
      const startedAt = Date.now();
      void (async () => {
        const ok = await flushLibraryImports(SHUTDOWN_FLUSH_TIMEOUT_MS, "app-quit");
        console.log(`[main/shutdown] library import flush ${ok ? "OK" : "TIMEOUT"} in ${Date.now() - startedAt}ms`);
        teardownSubsystems();
        await telemetry.flush().catch((err) => console.error("[main/shutdown] telemetry.flush Error:", err));
        clearTimeout(forceTimer);
        app.exit(0);
      })();
      return;
    }

    event.preventDefault();
    isQuitting = true;
    const startedAt = Date.now();
    const pendingIds = coordinator.listActive().map((b) => b.batchId);
    console.log(`[main/shutdown] flush path — ${pendingIds.length} active batches: ${pendingIds.join(", ")}`);
    telemetry.logEvent({ type: "shutdown.flush.start", pendingBatches: pendingIds });

    void (async () => {
      let exitCode = 0;
      try {
        const result = await coordinator.flushAll(SHUTDOWN_FLUSH_TIMEOUT_MS);
        if (result.ok) {
          console.log(`[main/shutdown] flush OK in ${Date.now() - startedAt}ms`);
          telemetry.logEvent({ type: "shutdown.flush.ok", durationMs: Date.now() - startedAt });
        } else {
          console.warn(`[main/shutdown] flush timeout, still pending: ${result.pending.join(", ")}`);
          telemetry.logEvent({ type: "shutdown.flush.timeout", pendingBatches: result.pending });
          exitCode = 0;
        }
      } catch (e) {
        console.error("[main/shutdown] flush error:", e);
        telemetry.logEvent({
          type: "shutdown.flush.error",
          error: e instanceof Error ? e.message : String(e),
        });
        exitCode = 0;
      } finally {
        teardownSubsystems();
        await telemetry.flush().catch((err) => console.error("[main/shutdown] telemetry.flush Error:", err));
        console.log("[main/shutdown] exiting with code", exitCode);
        clearTimeout(forceTimer);
        app.exit(exitCode);
      }
    })();
  });
}
