// @ts-check
/**
 * Import-actions для Import Pane: pickFolder, pickFiles, bundle, runImport,
 * drag&drop, и folder duplicate scan.
 *
 * Извлечено из `import-pane.js` (Phase 3.4 cross-platform roadmap, 2026-04-30).
 * Опирается на shared state `IMPORT_STATE` + `STATE` из state.js — выносить
 * их в context-параметр был бы overkill для renderer-singleton-кода.
 */

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { IMPORT_STATE, STATE } from "./state.js";
import { refreshCollectionViews } from "./collection-views.js";
import { showLibraryToast } from "./toast.js";
import { showAlert, showConfirm } from "../components/ui-dialog.js";
import { rerenderBooksPanel, resetBooksState } from "./import-pane-books.js";
import { rerenderStatusBar } from "./import-pane-statusbar.js";
import { showPreflightModal } from "./import-pane-preflight.js";

const IN_FLIGHT_TRIM = 200;

/**
 * Эффективное значение OCR для конкретного импорта: учитывает per-book override
 * (если пользователь поставил галочку в preview), иначе глобальный prefs.ocrEnabled.
 *
 * Без этой функции renderer вызывал importFolder/importFiles без `ocrEnabled`,
 * и md-converter.ts тихо отключал OCR auto-fallback — сканированные PDF/DJVU
 * пропускались как «no extractable text».
 *
 * @returns {boolean}
 */
function resolveOcrEnabled() {
  if (STATE?.ocrOverride === true) return true;
  if (STATE?.ocrOverride === false) return false;
  return Boolean(STATE?.prefs?.ocrEnabled);
}

/**
 * Запускает preflight (через IPC) и показывает модал с разбивкой
 * текстовых/image-only/инвалидных файлов + готовность OCR-движков.
 * Возвращает решение пользователя или null если preflight упал.
 *
 * @param {() => Promise<unknown>} runPreflightIpc — функция вызова IPC
 * @returns {Promise<import("./import-pane-preflight.js").PreflightDecision | null>}
 */
const PREFLIGHT_TIMEOUT_MS = 30_000;

async function runPreflightAndDecide(runPreflightIpc) {
  /** @type {any} */
  let report;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timeoutHandle;
  try {
    report = await Promise.race([
      runPreflightIpc(),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("preflight timeout")), PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn("[import] preflight failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    await showAlert(t("library.import.preflight.failed", { msg }));
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!report || report.totalFiles === 0) {
    await showAlert(t("library.import.preflight.failed", { msg: "no supported files found" }));
    return null;
  }
  try {
    return await showPreflightModal(report);
  } catch (modalErr) {
    console.warn("[import] showPreflightModal failed:", modalErr);
    await showAlert(t("library.import.preflight.failed", {
      msg: modalErr instanceof Error ? modalErr.message : String(modalErr),
    }));
    return null;
  }
}

/**
 * Общий поток «подтвердить → preflight → решение» для pick-based import.
 * Устраняет дублирование между importFromFolder и importFromFiles.
 *
 * @param {{
 *   confirmMessage: string;
 *   confirmTitle: string;
 *   preflightIpc: () => Promise<unknown>;
 *   handleDecision: (decision: import("./import-pane-preflight.js").PreflightDecision) => Promise<void>;
 * }} opts
 * @returns {Promise<void>}
 */
async function runImportFlowCore(opts) {
  const ok = await showConfirm(opts.confirmMessage, { title: opts.confirmTitle });
  if (!ok) return;

  const statusEl = document.querySelector(".lib-import-status");
  if (statusEl) statusEl.textContent = t("library.import.progress.preflight") || "Preflight scan…";
  const decision = await runPreflightAndDecide(opts.preflightIpc);
  if (statusEl) statusEl.textContent = "";

  if (!decision || decision.action === "cancel") return;
  if (decision.action === "configure-ocr") { openOcrSettings(); return; }

  try {
    await opts.handleDecision(decision);
  } catch (err) {
    console.error("[import] handleDecision threw unexpectedly:", err);
    showLibraryToast({
      kind: "error",
      message: t("library.import.preflight.failed", {
        msg: err instanceof Error ? err.message : String(err),
      }),
    });
  }
}

/** @param {{renderCatalog: (root: HTMLElement) => Promise<void>; focusCatalogBook?: (id: string) => void}} deps */
export async function importFromFolder(deps) {
  if (IMPORT_STATE.busy) {
    if (!IMPORT_STATE.importId && IMPORT_STATE.aggregate.startedAt) {
      const elapsed = Date.now() - IMPORT_STATE.aggregate.startedAt;
      if (elapsed > 30_000) {
        console.warn("[import] force-reset IMPORT_STATE.busy (stuck", Math.round(elapsed / 1000), "s)");
        IMPORT_STATE.busy = false;
      }
    }
    if (IMPORT_STATE.busy) {
      showLibraryToast({ kind: "info", message: t("library.import.busy") || "Import in progress…" });
      return;
    }
  }
  /** @type {string|null} */
  let folderPath = null;
  try { folderPath = await window.api.library.pickFolder(); } catch (_e) {
    console.warn("[import] pickFolder failed:", _e);
    showLibraryToast({ kind: "error", message: t("library.import.pickFolderFailed") });
    folderPath = null;
  }
  if (!folderPath) return;

  await runImportFlowCore({
    confirmMessage: t("library.import.confirm.startMessage", { folder: folderPath }),
    confirmTitle: t("library.import.confirm.startTitle"),
    preflightIpc: () => window.api.library.preflightFolder(folderPath, { recursive: IMPORT_STATE.recursive }),
    handleDecision: async (decision) => {
      /* "skip-image-only" для папки невозможен через текущий IPC importFolder
         (он ходит сам); поэтому если пользователь выбрал skip — конвертим
         решение в importFiles с отфильтрованным списком путей. */
      if (decision.action === "skip-image-only") {
        if (decision.paths.length === 0) {
          await showAlert(t("library.import.preflight.allImageOnly"));
          return;
        }
        await runImport(async () =>
          window.api.library.importFiles({
            paths: decision.paths,
            scanArchives: IMPORT_STATE.scanArchives,
            ocrEnabled: resolveOcrEnabled(),
          }),
          deps,
        );
        return;
      }
      await runImport(async () =>
        window.api.library.importFolder({
          folder: folderPath,
          scanArchives: IMPORT_STATE.scanArchives,
          ocrEnabled: resolveOcrEnabled(),
          maxDepth: IMPORT_STATE.recursive ? 16 : 0,
        }),
        deps,
      );
    },
  });
}

/**
 * Активирует Settings секцию OCR — пользователь может настроить vision_ocr
 * модель или поменять system OCR languages. Без жёсткой связи с router'ом —
 * просто переключаем активную секцию через DOM event который слушает
 * settings.js (если доступен) или показываем алерт-подсказку.
 */
function openOcrSettings() {
  /* Diff: dispatch событие; settings.js может его слушать. Если нет —
     fallback toast подсказывает пользователю куда зайти. */
  try {
    window.dispatchEvent(new CustomEvent("bibliary:open-settings", { detail: { section: "ocr" } }));
  } catch (_e) {
    /* swallow */
  }
  showLibraryToast({
    kind: "info",
    message: t("library.import.preflight.btn.configureOcr") + " → Settings → Models",
  });
}

/* Иt 8Г.4: importFolderAsBundle удалён — мёртвая функция (Inquisitor
   diagonal review подтвердил отсутствие callers в DOM/JSX и других модулях).
   Backend (electron/lib/scanner/folder-bundle/* + IPC scanner:start-folder-bundle)
   оставлен под @deprecated пометкой — модули используются тестами
   tests/folder-bundle*.test.ts напрямую (без IPC). */

/** @param {{renderCatalog: (root: HTMLElement) => Promise<void>; focusCatalogBook?: (id: string) => void}} deps */
export async function importFromFiles(deps) {
  if (IMPORT_STATE.busy) {
    if (!IMPORT_STATE.importId && IMPORT_STATE.aggregate.startedAt) {
      const elapsed = Date.now() - IMPORT_STATE.aggregate.startedAt;
      if (elapsed > 30_000) {
        console.warn("[import] force-reset IMPORT_STATE.busy (stuck", Math.round(elapsed / 1000), "s)");
        IMPORT_STATE.busy = false;
      }
    }
    if (IMPORT_STATE.busy) {
      showLibraryToast({ kind: "info", message: t("library.import.busy") || "Import in progress…" });
      return;
    }
  }
  /** @type {string[]} */
  let paths = [];
  try {
    const r = /** @type {any} */ (await window.api.library.pickFiles());
    paths = Array.isArray(r) ? r : (r?.paths ?? []);
  } catch (_e) {
    console.warn("[import] pickFiles failed:", _e);
    showLibraryToast({ kind: "error", message: t("library.import.pickFilesFailed") });
    paths = [];
  }
  if (paths.length === 0) return;

  await runImportFlowCore({
    confirmMessage: t("library.import.confirm.startFilesMessage", { count: String(paths.length) }),
    confirmTitle: t("library.import.confirm.startFilesTitle"),
    preflightIpc: () => window.api.library.preflightFiles(paths),
    handleDecision: async (decision) => {
      const finalPaths = decision.action === "skip-image-only" ? decision.paths : paths;
      if (finalPaths.length === 0) {
        if (decision.action === "skip-image-only") {
          await showAlert(t("library.import.preflight.allImageOnly"));
        }
        return;
      }
      await runImport(async () =>
        window.api.library.importFiles({
          paths: finalPaths,
          scanArchives: IMPORT_STATE.scanArchives,
          ocrEnabled: resolveOcrEnabled(),
        }),
        deps,
      );
    },
  });
}

/**
 * @param {() => Promise<any>} invoke
 * @param {{renderCatalog: (root: HTMLElement) => Promise<void>; focusCatalogBook?: (id: string) => void}} deps
 */
async function runImport(invoke, deps) {
  const root = document.getElementById("library-root");
  if (!root) return;
  const status = root.querySelector(".lib-import-status");
  IMPORT_STATE.busy = true;
  IMPORT_STATE.aggregate.startedAt = Date.now();
  let unsubscribeProgress = null;
  try {
    resetBooksState();
    rerenderStatusBar();
    if (status) status.textContent = t("library.import.progress.starting");
    if (typeof window.api?.library?.onImportProgress === "function") {
      unsubscribeProgress = window.api.library.onImportProgress((evt) => {
        if (evt?.importId && !IMPORT_STATE.importId) {
          IMPORT_STATE.importId = evt.importId;
        }
        const discovered = Number(evt?.discovered ?? 0);
        const processed = Number(evt?.processed ?? 0);
        IMPORT_STATE.aggregate.discovered = Math.max(IMPORT_STATE.aggregate.discovered, discovered);
        IMPORT_STATE.aggregate.processed = Math.max(IMPORT_STATE.aggregate.processed, processed);

        if (evt?.phase === "file-start") {
          const filePath = String(evt?.currentFile || "");
          const fileName = filePath.split(/[\\/]/).pop() || t("library.import.progress.unknownFile");
          if (filePath) {
            IMPORT_STATE.inFlight.set(filePath, {
              filePath,
              fileName,
              status: "processing",
              startedAt: Date.now(),
            });
            trimInFlight();
          }
          if (status) status.textContent = t("library.import.progress.processing", {
            file: fileName,
            done: String(processed),
            total: String(Math.max(discovered, processed)),
          });
        } else if (evt?.phase === "processed") {
          const filePath = String(evt?.currentFile || "");
          const outcome = String(evt?.outcome || "skipped");
          /* Map IPC outcome → BookProgress status (added/duplicate/skipped/failed). */
          const status_ = (outcome === "added" || outcome === "duplicate" || outcome === "skipped" || outcome === "failed")
            ? outcome : "skipped";
          if (filePath) {
            const existing = IMPORT_STATE.inFlight.get(filePath);
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            IMPORT_STATE.inFlight.set(filePath, {
              filePath,
              fileName,
              status: status_,
              startedAt: existing?.startedAt ?? Date.now(),
              finishedAt: Date.now(),
              outcome,
              errorMessage: typeof evt?.errorMessage === "string" ? evt.errorMessage : undefined,
              warnings: Array.isArray(evt?.fileWarnings) ? evt.fileWarnings.slice(0, 5) : undefined,
              duplicateReason: typeof evt?.duplicateReason === "string" ? evt.duplicateReason : undefined,
            });
          }
          if (status_ === "added") IMPORT_STATE.aggregate.added++;
          else if (status_ === "duplicate") IMPORT_STATE.aggregate.duplicate++;
          else if (status_ === "skipped") IMPORT_STATE.aggregate.skipped++;
          else if (status_ === "failed") IMPORT_STATE.aggregate.failed++;

          if (status) status.textContent = t("library.import.progress.copying", {
            done: String(processed),
            total: String(Math.max(discovered, processed)),
          });
          if (outcome === "duplicate" && evt?.existingBookId) {
            const msgKey = evt?.duplicateReason === "duplicate_older_revision"
              ? "library.import.toast.duplicateOlder"
              : "library.import.toast.duplicateSha";
            showLibraryToast({
              kind: "info",
              message: t(msgKey, {
                title: evt.existingBookTitle || evt.existingBookId,
              }),
              actionLabel: t("library.import.toast.openCatalog"),
              onAction: () => deps.focusCatalogBook?.(evt.existingBookId),
              dedupeKey: `${evt.duplicateReason || "duplicate"}:${evt.existingBookId}`,
            });
          }
        } else {
          if (status) status.textContent = t("library.import.progress.scanning", {
            found: String(discovered),
          });
        }
        rerenderBooksPanel();
        rerenderStatusBar();
      });
    }
    const res = await invoke();
    IMPORT_STATE.importId = res.importId || null;
    if (typeof res?.added === "number") IMPORT_STATE.aggregate.added = res.added;
    if (typeof res?.duplicate === "number") IMPORT_STATE.aggregate.duplicate = res.duplicate;
    if (typeof res?.skipped === "number") IMPORT_STATE.aggregate.skipped = res.skipped;
    if (typeof res?.failed === "number") IMPORT_STATE.aggregate.failed = res.failed;
    rerenderStatusBar();
    const doneMsg = t("library.import.progress.done", {
      added: String(res.added ?? 0),
      skipped: String((res.skipped ?? 0) + (res.duplicate ?? 0) + (res.failed ?? 0)),
    });
    if (status) status.textContent = doneMsg;
    if ((res.added ?? 0) === 0) {
      showLibraryToast({ kind: "info", message: doneMsg });
    }
    void deps.renderCatalog(root);
    refreshCollectionViews();
  } catch (e) {
    const errMsg = t("library.import.progress.failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    if (status) status.textContent = errMsg;
    showLibraryToast({ kind: "error", message: errMsg });
  } finally {
    if (typeof unsubscribeProgress === "function") {
      try { unsubscribeProgress(); } catch (_e) { /* tolerate: listener cleanup */ }
    }
    IMPORT_STATE.busy = false;
    IMPORT_STATE.importId = null;
    try { await window.api.library.evaluatorResume(); } catch (_e) { /* resume on cleanup is best-effort */ }
  }
}

/**
 * Bound memory: keep only last IN_FLIGHT_TRIM (200) entries. При импорте
 * 5000+ файлов карта не разрастается.
 */
function trimInFlight() {
  if (IMPORT_STATE.inFlight.size <= IN_FLIGHT_TRIM) return;
  /* Remove oldest finished entries first. */
  const finished = [];
  for (const [k, v] of IMPORT_STATE.inFlight) {
    if (v.status !== "processing") finished.push([k, v.finishedAt ?? v.startedAt]);
  }
  finished.sort((a, b) => /** @type {number} */ (a[1]) - /** @type {number} */ (b[1]));
  const toRemove = IMPORT_STATE.inFlight.size - IN_FLIGHT_TRIM;
  for (let i = 0; i < toRemove && i < finished.length; i++) {
    IMPORT_STATE.inFlight.delete(/** @type {string} */ (finished[i][0]));
  }
}

/* ─── Drag & Drop ──────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} dropzone
 * @param {{renderCatalog: (root: HTMLElement) => Promise<void>; focusCatalogBook?: (id: string) => void}} deps
 */
export function installImportDropHandlers(dropzone, deps) {
  const stop = (/** @type {DragEvent} */ ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  for (const evName of ["dragenter", "dragover"]) {
    dropzone.addEventListener(evName, (ev) => {
      stop(/** @type {DragEvent} */ (ev));
      dropzone.classList.add("lib-import-dropzone-active");
    });
  }
  for (const evName of ["dragleave", "drop"]) {
    dropzone.addEventListener(evName, (ev) => {
      stop(/** @type {DragEvent} */ (ev));
      dropzone.classList.remove("lib-import-dropzone-active");
    });
  }

  dropzone.addEventListener("drop", async (ev) => {
    const entries = collectDroppedEntries(/** @type {DragEvent} */ (ev));
    if (entries.length === 0) return;

    /* Preflight для DnD: собираем все пути (в т.ч. рекурсивно через preflight
       для папок) — IPC сам обходит. Подаём в preflight либо folder paths
       (если drop был на папку), либо файлы. Если миксованный drop —
       приоритет у файлов; для папок отдельный preflightFolder вызов. */
    const filePaths = entries.filter((e) => !e.isDirectory).map((e) => e.path);
    const dirPaths = entries.filter((e) => e.isDirectory).map((e) => e.path);

    /** @type {any} */
    let report = null;
    try {
      /** @type {Promise<any>} */
      let preflightP;
      if (dirPaths.length === 1 && filePaths.length === 0) {
        preflightP = window.api.library.preflightFolder(dirPaths[0], { recursive: IMPORT_STATE.recursive });
      } else if (filePaths.length > 0 && dirPaths.length === 0) {
        preflightP = window.api.library.preflightFiles(filePaths);
      } else {
        await runImport(() => importDroppedEntries(entries), deps);
        return;
      }
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let dndTimeoutHandle;
      try {
        report = await Promise.race([
          preflightP,
          new Promise((_, reject) => {
            dndTimeoutHandle = setTimeout(() => reject(new Error("preflight timeout")), PREFLIGHT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(dndTimeoutHandle);
      }
    } catch (err) {
      console.warn("[import] preflight (DnD) failed:", err);
      await showAlert(t("library.import.preflight.failed", { msg: err instanceof Error ? err.message : String(err) }));
      return;
    }

    if (!report || report.totalFiles === 0) {
      await showAlert(t("library.import.preflight.failed", { msg: "no supported files in drop" }));
      return;
    }

    let decision;
    try {
      decision = await showPreflightModal(report);
    } catch (modalErr) {
      console.warn("[import] showPreflightModal (DnD) failed:", modalErr);
      await showAlert(t("library.import.preflight.failed", {
        msg: modalErr instanceof Error ? modalErr.message : String(modalErr),
      }));
      return;
    }
    if (!decision || decision.action === "cancel") return;
    if (decision.action === "configure-ocr") {
      openOcrSettings();
      return;
    }

    if (decision.action === "skip-image-only") {
      if (decision.paths.length === 0) {
        await showAlert(t("library.import.preflight.allImageOnly"));
        return;
      }
      await runImport(async () =>
        window.api.library.importFiles({
          paths: decision.paths,
          scanArchives: IMPORT_STATE.scanArchives,
          ocrEnabled: resolveOcrEnabled(),
        }),
        deps,
      );
      return;
    }

    await runImport(() => importDroppedEntries(entries), deps);
  });
}

/**
 * @param {DragEvent} ev
 * @returns {{path: string; isDirectory: boolean}[]}
 */
function collectDroppedEntries(ev) {
  /** @type {{path: string; isDirectory: boolean}[]} */
  const entries = [];
  const seen = new Set();
  const items = ev.dataTransfer?.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const file = item.getAsFile?.();
      const filePath = file?.path;
      if (!filePath || seen.has(filePath)) continue;
      const entry = item.webkitGetAsEntry?.();
      entries.push({ path: filePath, isDirectory: entry?.isDirectory === true });
      seen.add(filePath);
    }
  }
  const files = ev.dataTransfer?.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i].path;
      if (!filePath || seen.has(filePath)) continue;
      entries.push({ path: filePath, isDirectory: false });
      seen.add(filePath);
    }
  }
  return entries;
}

/** @param {{path: string; isDirectory: boolean}[]} entries */
async function importDroppedEntries(entries) {
  const files = entries.filter((e) => !e.isDirectory).map((e) => e.path);
  const dirs = entries.filter((e) => e.isDirectory).map((e) => e.path);
  const total = { importId: null, added: 0, skipped: 0, duplicate: 0, failed: 0 };
  const merge = (/** @type {any} */ res) => {
    if (!res) return;
    total.importId = res.importId || total.importId;
    total.added += Number(res.added ?? 0);
    total.skipped += Number(res.skipped ?? 0);
    total.duplicate += Number(res.duplicate ?? 0);
    total.failed += Number(res.failed ?? 0);
  };

  const ocrEnabled = resolveOcrEnabled();
  if (files.length > 0) {
    merge(await window.api.library.importFiles({
      paths: files,
      scanArchives: IMPORT_STATE.scanArchives,
      ocrEnabled,
    }));
  }
  for (const folder of dirs) {
    merge(await window.api.library.importFolder({
      folder,
      scanArchives: IMPORT_STATE.scanArchives,
      ocrEnabled,
      maxDepth: IMPORT_STATE.recursive ? 16 : 0,
    }));
  }
  return total;
}

/* ─── Pre-import duplicate scan ────────────────────────────────────── */

/**
 * @param {HTMLElement} statusEl
 * @param {HTMLElement} reportContainer
 */
export async function scanFolderForDuplicates(statusEl, reportContainer) {
  if (IMPORT_STATE.busy) return;

  /** @type {string|null} */
  let folderPath = null;
  try {
    folderPath = await window.api.library.pickFolder();
  } catch (_e) {
    console.warn("[scan] pickFolder failed:", _e);
    showLibraryToast({ kind: "error", message: t("library.import.pickFolderFailed") });
  }
  if (!folderPath) return;

  IMPORT_STATE.busy = true;
  IMPORT_STATE.aggregate.startedAt = Date.now();
  statusEl.textContent = t("library.import.scan.starting");
  reportContainer.innerHTML = "";

  let scanId = "";
  /** @type {(() => void)|null} */
  let unsubProgress = null;
  /** @type {(() => void)|null} */
  let unsubReport = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let safetyTimer = null;

  const cleanup = () => {
    if (safetyTimer !== null) { clearTimeout(safetyTimer); safetyTimer = null; }
    if (typeof unsubProgress === "function") { try { unsubProgress(); } catch (_e) { /* */ } }
    if (typeof unsubReport === "function") { try { unsubReport(); } catch (_e) { /* */ } }
    unsubProgress = null;
    unsubReport = null;
    IMPORT_STATE.busy = false;
  };

  unsubProgress = window.api.library.onScanProgress((evt) => {
    if (scanId && evt.scanId !== scanId) return;
    if (evt.phase === "walking") {
      statusEl.textContent = t("library.import.scan.walking", {
        n: String(evt.bookFilesFound),
      });
    } else if (evt.phase === "metadata") {
      statusEl.textContent = t("library.import.scan.metadata", {
        done: String(evt.scannedFiles),
        total: String(evt.totalFiles),
      });
    } else if (evt.phase === "dedup") {
      statusEl.textContent = t("library.import.scan.dedup");
    }
  });

  unsubReport = window.api.library.onScanReport((payload) => {
    if (scanId && payload.scanId !== scanId) return;
    if (payload.error) {
      statusEl.textContent = t("library.import.scan.failed", { msg: payload.error });
    } else {
      statusEl.textContent = "";
      renderScanReport(/** @type {any} */ (payload.report), reportContainer);
    }
    cleanup();
  });

  try {
    const res = await window.api.library.scanFolder(folderPath);
    scanId = res.scanId;
    safetyTimer = setTimeout(() => {
      if (IMPORT_STATE.busy) {
        console.warn("[scan] safety timeout — scan report never arrived, resetting busy");
        statusEl.textContent = t("library.import.scan.error", { msg: "timeout — no report received" });
        cleanup();
      }
    }, 120_000);
  } catch (e) {
    statusEl.textContent = t("library.import.scan.error", {
      msg: e instanceof Error ? e.message : String(e),
    });
    cleanup();
  }
}

/**
 * @param {any} report
 * @param {HTMLElement} container
 */
function renderScanReport(report, container) {
  container.innerHTML = "";
  if (!report) return;

  const summary = el("div", { class: "lib-scan-summary" }, [
    el("div", { class: "lib-scan-stat" }, t("library.import.scan.report.books", { n: String(report.bookFiles) })),
    el("div", { class: "lib-scan-stat" }, t("library.import.scan.report.exact", { n: String(report.exactDuplicates) })),
    el("div", { class: "lib-scan-stat" }, t("library.import.scan.report.format", { n: String(report.formatDuplicates) })),
    el("div", { class: "lib-scan-stat" }, t("library.import.scan.report.fuzzy", { n: String(report.fuzzyMatches?.length ?? 0) })),
    el("div", { class: "lib-scan-stat lib-scan-stat-highlight" }, t("library.import.scan.report.unique", { n: String(report.uniqueBooks) })),
  ]);
  container.appendChild(summary);

  if (report.editionGroups && report.editionGroups.length > 0) {
    const edTitle = el("div", { class: "lib-scan-section-title" },
      t("library.import.scan.report.editions", { n: String(report.editionGroups.length) }));
    container.appendChild(edTitle);

    for (const group of report.editionGroups.slice(0, 100)) {
      const groupEl = el("details", { class: "lib-scan-group" }, [
        el("summary", {}, `${group.title} — ${group.author} (${group.editions.length} versions)`),
        ...group.editions.map((ed) => {
          const isRec = ed.path === group.recommended;
          return el("div", {
            class: isRec ? "lib-scan-edition lib-scan-recommended" : "lib-scan-edition",
          }, `${isRec ? "★ " : ""}${ed.format.toUpperCase()} ${ed.year ?? ""} — ${(ed.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
        }),
      ]);
      container.appendChild(groupEl);
    }
  }

  if (report.fuzzyMatches && report.fuzzyMatches.length > 0) {
    const fzTitle = el("div", { class: "lib-scan-section-title" },
      t("library.import.scan.report.fuzzyTitle", { n: String(report.fuzzyMatches.length) }));
    container.appendChild(fzTitle);

    for (const pair of report.fuzzyMatches.slice(0, 50)) {
      const pairEl = el("div", { class: "lib-scan-fuzzy-pair" }, [
        el("div", { class: "lib-scan-fuzzy-conf" }, `${Math.round(pair.confidence * 100)}%`),
        el("div", {}, `A: ${pair.bookA.title} — ${pair.bookA.author}`),
        el("div", {}, `B: ${pair.bookB.title} — ${pair.bookB.author}`),
      ]);
      container.appendChild(pairEl);
    }
  }
}
