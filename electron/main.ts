import { app, BrowserWindow, session, protocol, net, type OnHeadersReceivedListenerDetails } from "electron";
import * as path from "path";
import {
  registerAllIpcHandlers,
  abortAllIngests,
  abortAllDatasetV2,
  abortAllLibrary,
  activeLibraryImportCount,
  flushLibraryImports,
  bootstrapLibrarySubsystem,
} from "./ipc";
import { disposeClientAsync } from "./lmstudio-client";
import { getModelPool } from "./lib/llm/model-pool.js";
import { triggerAppShutdown } from "./lib/app-lifecycle.js";
import {
  initResilienceLayer,
  coordinator,
  telemetry,
} from "./lib/resilience";
import { initPreferencesStore } from "./lib/preferences/store.js";
import { registerExtractionPipeline } from "./lib/dataset-v2/coordinator-pipeline";
import { startWatchdog, stopWatchdog } from "./lib/resilience/lmstudio-watchdog";
import {
  startSchedulerSnapshotBroadcaster,
  stopSchedulerSnapshotBroadcaster,
} from "./lib/resilience/scheduler-snapshot-broadcaster";
import {
  startModelPoolSnapshotBroadcaster,
  stopModelPoolSnapshotBroadcaster,
} from "./lib/resilience/model-pool-snapshot-broadcaster";
import { SHUTDOWN_FLUSH_TIMEOUT_MS } from "./lib/resilience/constants";
import { getWindowsParentExecutablePath, resolveAppDataDir } from "./lib/app-data-dir.js";
import { closeCacheDb } from "./lib/library/cache-db.js";
import { killAllSynthChildren } from "./ipc/dataset-v2.ipc.js";
import { resolveBlobFromUrl, getBlobsRoot } from "./lib/library/library-store.js";
import { resolveLibraryRoot } from "./lib/library/paths.js";
import { applySmokeHarnessGate } from "./lib/smoke-harness-gate.js";

/* SECURITY (audit 2026-05-09): block BIBLIARY_SMOKE_UI_HARNESS=1 in packaged
   builds. Без этого gate инжекция env заставила бы preload подменить
   library IPC fake-данными — пользователь увидит чужой каталог, deleteBook
   ничего не удалит, burnAll soft-вернёт success. Должно стоять ДО любого
   `new BrowserWindow(...)` — preload наследует env от main. */
{
  const gateResult = applySmokeHarnessGate({
    isPackaged: app.isPackaged,
    env: process.env,
    log: (msg) => console.error(msg),
  });
  if (gateResult.blocked) {
    /* Дополнительный защитный слой: если кто-то всё-таки прошёл
       через build-time подмену, это попадёт в crash log. */
    console.error(`[main/security] smoke harness gate result: ${gateResult.reason}`);
  }
}

/* Disable libvips ORC SIMD vector codegen — prevents access violations on Windows
   portable builds (known orc_code_chunk_merge crash in GStreamer/liborc < 0.4.34).
   Must be set before any `import('sharp')` resolves — placed here at module top. */
process.env.VIPS_NOVECTOR = "1";

/* Increase V8 heap limit for long-running import sessions (default ~1.5 GB
   fragments after 4+ hours of Buffer-heavy DJVU processing).
   Must be set before app initialises — commandLine flags are read at Electron startup. */
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");

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
 *   - connect: self + Google Fonts + http(s):// localhost (LM Studio)
 *     + http(s)://* for HF / BookHunter sources
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
  const isMac = process.platform === "darwin";
  /* Иконка для окна: на Linux обязательна (taskbar/dock-иконка), на Win
     полезна как fallback пока .ico не подгружен из NSIS-установки.
     На macOS иконка приходит из app bundle (.icns), параметр игнорируется. */
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: BG_COLOR,
    title: "Bibliary",
    icon: iconPath,
    /* macOS: native traffic lights inside the dark window frame.
       "hiddenInset" keeps the standard traffic lights but lets
       the renderer extend under the title bar (no white bar). */
    ...(isMac ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 14 },
    } : {}),
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
    const dataDir = resolveAppDataDir({
      env: process.env,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appName: app.getName(),
      devBaseDir: __dirname,
      platform: process.platform,
      parentExecutablePath: process.platform === "win32" ? getWindowsParentExecutablePath() : null,
      /* macOS packaged: execPath is inside read-only .app bundle —
         pass userData so resolveAppDataDir routes to ~/Library/Application Support. */
      userDataPath: app.getPath("userData"),
    });
    process.env.BIBLIARY_DATA_DIR = dataDir;

    await initResilienceLayer({ dataDir });
    const prefsStore = initPreferencesStore(dataDir);
    await prefsStore.ensureDefaults();
    const prefs = await prefsStore.getAll();
    const { applyRuntimeSideEffects } = await import("./ipc/preferences.ipc.js");
    applyRuntimeSideEffects(prefs);

    /* In-process LanceDB connection. Заменяет HTTP Chroma + auto-spawn
       child-process. Открываем ОДИН раз тут, до registerAllIpcHandlers,
       чтобы все IPC-хендлеры могли getDb() без race на init. */
    const { initVectorDb } = await import("./lib/vectordb/index.js");
    await initVectorDb({ dataDir });

    registerExtractionPipeline();
    applyCsp();
    registerAssetProtocol();
    startWatchdog(() => mainWindow);
    startSchedulerSnapshotBroadcaster(() => mainWindow);
    startModelPoolSnapshotBroadcaster(() => mainWindow);
    registerAllIpcHandlers(() => mainWindow);
    void bootstrapLibrarySubsystem(() => mainWindow)
      .catch((err) => console.error("[main] bootstrapLibrarySubsystem failed:", err));
    /* Audit A10 (Wave2): best-effort cleanup orphan'ов bibliary-archive-* в %TEMP%
       от предыдущих crash-сессий. Не блокирующий, не валится при ошибках. */
    void import("./lib/library/archive-extractor.js")
      .then(({ cleanupOrphanedArchiveTempDirs }) =>
        cleanupOrphanedArchiveTempDirs().then((res) => {
          if (res.removed > 0) console.log(`[startup] archive temp cleanup: removed ${res.removed} orphan dirs (errors: ${res.errors})`);
        }),
      )
      .catch(() => { /* best-effort */ });
    /* Application menu: macOS — стандартный набор (App / File / Edit / View / Window / Help)
       с правильными ⌘-акселераторами; Win/Linux — без отдельного App menu. */
    const { installApplicationMenu } = await import("./lib/app-menu.js");
    installApplicationMenu();
    createWindow();
  }).catch((err) => {
    console.error("[main] fatal startup error — createWindow was never called:", err);
    const { dialog } = require("electron") as typeof import("electron");
    dialog.showErrorBox(
      "Bibliary — startup failed",
      `Initialization error:\n\n${err instanceof Error ? err.message : String(err)}\n\nThe application will now quit.`,
    );
    app.exit(1);
  });

  /* macOS: keep the app alive when all windows are closed
     (standard macOS convention — re-open via dock or Cmd+N). */
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  /* macOS: clicking the dock icon re-opens the main window. */
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  const FORCE_EXIT_MS = 4_000;

  function teardownSubsystems(): void {
    const subsystems: [string, () => void][] = [
      ["triggerAppShutdown", triggerAppShutdown],
      ["stopWatchdog", stopWatchdog],
      ["stopSchedulerSnapshotBroadcaster", stopSchedulerSnapshotBroadcaster],
      ["stopModelPoolSnapshotBroadcaster", stopModelPoolSnapshotBroadcaster],
      ["abortAllIngests", () => abortAllIngests("app-quit")],
      ["abortAllDatasetV2", () => abortAllDatasetV2("app-quit")],
      ["killAllSynthChildren", killAllSynthChildren],
      ["abortAllLibrary", () => abortAllLibrary("app-quit")],
      ["closeCacheDb", closeCacheDb],
      ["closeVectorDb", () => {
        /* In-process LanceDB connection close — освобождает native file
           handles на .lance/.lock. На Windows без этого `rm -r` data dir
           валится с EBUSY. Best-effort fire-and-forget. */
        void import("./lib/vectordb/index.js")
          .then(({ closeDb }) => closeDb())
          .catch(() => { /* ignore */ });
      }],
      ["disposeTesseract", () => {
        /* Tesseract.js worker terminate — освобождает WASM heap (~30 MB)
         * и worker_thread. Если worker никогда не создавался (OCR не
         * вызывался) — disposeTesseract no-op. */
        void import("./lib/scanner/ocr/tesseract.js")
          .then(({ disposeTesseract }) => disposeTesseract())
          .catch(() => { /* ignore */ });
      }],
    ];
    for (const [label, fn] of subsystems) {
      try { fn(); } catch (e) {
        console.error(`[main/shutdown] ${label} Error:`, e);
      }
    }
  }

  /** Absolute last-resort exit: kills the process even if app.exit()
   *  doesn't terminate due to a native addon holding a handle. */
  function hardExit(code = 0): void {
    try { app.exit(code); } catch { /* ignore */ }
    setTimeout(() => { process.exit(code); }, 300).unref();
  }

  /**
   * Закрытие всех LM Studio ресурсов — eviction моделей пула + dispose клиента.
   * Все шаги best-effort с timeout: quit не должен зависать дольше 4с (force-exit).
   */
  async function disposeAllLmStudioResources(): Promise<void> {
    try {
      const evicted = await Promise.race([
        getModelPool().forceEvictAll(),
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2_000).unref()),
      ]);
      if (evicted >= 0) console.log(`[main/shutdown] model-pool.forceEvictAll: ${evicted} models unloaded`);
      else console.warn("[main/shutdown] model-pool.forceEvictAll: TIMEOUT (2s)");
    } catch (err) {
      console.error("[main/shutdown] model-pool.forceEvictAll Error:", err);
    }
    try {
      const closedOk = await disposeClientAsync(1_500);
      console.log(`[main/shutdown] LM Studio main client dispose: ${closedOk ? "OK" : "TIMEOUT/ERROR"}`);
    } catch (err) {
      console.error("[main/shutdown] disposeClientAsync Error:", err);
    }
  }

  let isQuitting = false;
  app.on("before-quit", (event) => {
    if (isQuitting) return;

    const forceTimer = setTimeout(() => {
      console.error("[main/shutdown] force-exit after timeout");
      hardExit(0);
    }, FORCE_EXIT_MS);
    forceTimer.unref();

    const activeImports = activeLibraryImportCount();
    const idle = !coordinator.isAnyActive() && activeImports === 0;

    if (idle) {
      console.log("[main/shutdown] idle path — no active batches or imports");
      event.preventDefault();
      isQuitting = true;
      void (async () => {
        try {
          teardownSubsystems();
          await disposeAllLmStudioResources();
          await telemetry.flush().catch((err) => console.error("[main/shutdown] telemetry.flush Error:", err));
          console.log("[main/shutdown] idle path — clean exit");
        } catch (e) {
          console.error("[main/shutdown] idle path error:", e);
        } finally {
          clearTimeout(forceTimer);
          hardExit(0);
        }
      })();
      return;
    }

    if (activeImports > 0) {
      console.log(`[main/shutdown] flush path — ${activeImports} active library imports`);
      event.preventDefault();
      isQuitting = true;
      const startedAt = Date.now();
      void (async () => {
        try {
          const ok = await flushLibraryImports(SHUTDOWN_FLUSH_TIMEOUT_MS, "app-quit");
          console.log(`[main/shutdown] library import flush ${ok ? "OK" : "TIMEOUT"} in ${Date.now() - startedAt}ms`);
          teardownSubsystems();
          await disposeAllLmStudioResources();
          await telemetry.flush().catch((err) => console.error("[main/shutdown] telemetry.flush Error:", err));
        } catch (e) {
          console.error("[main/shutdown] flush-imports path error:", e);
        } finally {
          clearTimeout(forceTimer);
          hardExit(0);
        }
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
        }
      } catch (e) {
        console.error("[main/shutdown] flush error:", e);
        telemetry.logEvent({
          type: "shutdown.flush.error",
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        teardownSubsystems();
        await disposeAllLmStudioResources();
        await telemetry.flush().catch((err) => console.error("[main/shutdown] telemetry.flush Error:", err));
        console.log("[main/shutdown] exiting with code", exitCode);
        clearTimeout(forceTimer);
        hardExit(exitCode);
      }
    })();
  });

  /* v0.11.14: SIGINT (Ctrl+C) / SIGTERM (kill, taskkill) → graceful shutdown.
     Раньше внешнее завершение процесса НЕ запускало `before-quit` хендлер —
     LM Studio оставался с висячим WebSocket. Теперь сигналы маршрутизируются
     в стандартный quit-flow, который проходит через disposeAllLmStudioResources. */
  const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const sig of SHUTDOWN_SIGNALS) {
    process.on(sig, () => {
      console.log(`[main] received ${sig} — initiating graceful shutdown`);
      try { app.quit(); } catch { hardExit(0); }
    });
  }
}
