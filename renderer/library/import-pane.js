// @ts-check
/**
 * Import pane: folder/file import with live progress and evaluator panel.
 */
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { IMPORT_STATE } from "./state.js";
import { buildEvaluatorPanel, refreshEvaluatorState } from "./evaluator.js";
import { showLibraryToast } from "./toast.js";

/**
 * @param {object} deps
 * @param {(root: HTMLElement) => Promise<void>} deps.renderCatalog
 * @param {(bookId: string) => Promise<void> | void} [deps.focusCatalogBook]
 * @returns {HTMLElement}
 */
export function buildImportPane(deps) {
  const archiveCb = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    class: "lib-import-cb",
    checked: IMPORT_STATE.scanArchives ? "checked" : undefined,
  }));
  archiveCb.addEventListener("change", () => { IMPORT_STATE.scanArchives = archiveCb.checked; });

  const pickFolderBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-primary lib-import-pick-folder",
    onclick: () => importFromFolder(deps),
  }, t("library.import.btn.pickFolder"));

  const pickFilesBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-pick-files",
    onclick: () => importFromFiles(deps),
  }, t("library.import.btn.pickFiles"));

  const cancelBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-cancel",
    style: "display:none",
    onclick: async () => {
      if (IMPORT_STATE.importId) {
        try { await window.api.library.cancelImport(IMPORT_STATE.importId); }
        catch (_e) { console.warn("[import] cancelImport failed:", _e); }
      }
    },
  }, t("library.import.btn.cancel"));

  const opts = el("div", { class: "lib-import-opts" }, [
    el("label", { class: "lib-import-opt", title: t("library.import.opt.tooltip.scanArchives") }, [
      archiveCb, t("library.import.opt.scanArchives"),
    ]),
  ]);

  const dropzone = el("div", {
    class: "lib-import-dropzone",
    role: "button",
    tabindex: "0",
    "aria-label": t("library.import.dropzone.title"),
    onclick: () => importFromFiles(deps),
    onkeydown: (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); importFromFiles(deps); }
    },
  }, [
    el("div", { class: "lib-import-dropzone-icon", "aria-hidden": "true" }, "+"),
    el("div", { class: "lib-import-dropzone-title" }, t("library.import.dropzone.title")),
    el("div", { class: "lib-import-dropzone-hint" }, t("library.import.dropzone.hint")),
  ]);

  const status = el("div", { class: "lib-import-status", "aria-live": "polite" }, "");

  const evaluatorPanel = buildEvaluatorPanel();

  const scanBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-scan-folder",
    onclick: () => scanFolderForDuplicates(status, scanReportContainer),
  }, t("library.import.btn.scanFolder") || "Scan Folder (Dedup Report)");

  const scanReportContainer = el("div", { class: "lib-scan-report" });

  const body = el("div", { class: "lib-import-body" }, [
    dropzone,
    el("div", { class: "lib-import-actions" }, [pickFolderBtn, pickFilesBtn, scanBtn, cancelBtn]),
    opts,
    status,
    scanReportContainer,
    evaluatorPanel,
  ]);

  return el("div", { class: "lib-pane lib-pane-import" }, [body]);
}

/** @param {HTMLElement} root */
export function renderImport(root) {
  void refreshEvaluatorState(root);
}

/** @param {object} deps */
async function importFromFolder(deps) {
  if (IMPORT_STATE.busy) return;
  /** @type {string|null} */
  let folderPath = null;
  try { folderPath = await window.api.library.pickFolder(); } catch (_e) { console.warn("[import] pickFolder failed:", _e); folderPath = null; }
  if (!folderPath) return;
  await runImport(async () =>
    window.api.library.importFolder({
      folder: folderPath,
      scanArchives: IMPORT_STATE.scanArchives,
    }),
    deps,
  );
}

/** @param {object} deps */
async function importFromFiles(deps) {
  if (IMPORT_STATE.busy) return;
  /** @type {string[]} */
  let paths = [];
  try {
    const r = /** @type {any} */ (await window.api.library.pickFiles());
    paths = Array.isArray(r) ? r : (r?.paths ?? []);
  } catch (_e) { console.warn("[import] pickFiles failed:", _e); paths = []; }
  if (paths.length === 0) return;
  await runImport(async () =>
    window.api.library.importFiles({
      paths,
      scanArchives: IMPORT_STATE.scanArchives,
    }),
    deps,
  );
}

/**
 * @param {() => Promise<any>} invoke
 * @param {object} deps
 */
async function runImport(invoke, deps) {
  const root = document.getElementById("library-root");
  if (!root) return;
  const status = root.querySelector(".lib-import-status");
  const cancelBtn = /** @type {HTMLElement|null} */ (root.querySelector(".lib-import-cancel"));
  IMPORT_STATE.busy = true;
  if (cancelBtn) cancelBtn.style.display = "";
  if (status) status.textContent = "...";
  let unsubscribeProgress = null;
  try {
    if (typeof window.api?.library?.onImportProgress === "function") {
      unsubscribeProgress = window.api.library.onImportProgress((evt) => {
        if (!status) return;
        if (evt?.importId && !IMPORT_STATE.importId) {
          IMPORT_STATE.importId = evt.importId;
        }
        const discovered = Number(evt?.discovered ?? 0);
        const processed = Number(evt?.processed ?? 0);
        if (evt?.phase === "processed") {
          status.textContent = t("library.import.progress.copying", {
            done: String(processed),
            total: String(Math.max(discovered, processed)),
          });
          if (evt?.outcome === "duplicate" && evt?.existingBookId) {
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
          status.textContent = t("library.import.progress.scanning", {
            found: String(discovered),
          });
        }
      });
    }
    const res = await invoke();
    IMPORT_STATE.importId = res.importId || null;
    if (status) status.textContent = t("library.import.progress.done", {
      added: String(res.added ?? 0),
      skipped: String((res.skipped ?? 0) + (res.duplicate ?? 0) + (res.failed ?? 0)),
    });
    void deps.renderCatalog(root);
  } catch (e) {
    if (status) status.textContent = t("library.import.progress.failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    if (typeof unsubscribeProgress === "function") {
      try { unsubscribeProgress(); } catch (_e) { /* tolerate: listener cleanup */ }
    }
    IMPORT_STATE.busy = false;
    IMPORT_STATE.importId = null;
    if (cancelBtn) cancelBtn.style.display = "none";
  }
}

/**
 * @param {HTMLElement} statusEl
 * @param {HTMLElement} reportContainer
 */
async function scanFolderForDuplicates(statusEl, reportContainer) {
  if (IMPORT_STATE.busy) return;

  /** @type {string|null} */
  let folderPath = null;
  try {
    folderPath = await window.api.library.pickFolder();
  } catch (_e) { console.warn("[scan] pickFolder failed:", _e); }
  if (!folderPath) return;

  IMPORT_STATE.busy = true;
  statusEl.textContent = t("library.import.scan.starting") || "Starting scan...";
  reportContainer.innerHTML = "";

  let scanId = "";
  /** @type {(() => void)|null} */
  let unsubProgress = null;
  /** @type {(() => void)|null} */
  let unsubReport = null;

  const cleanup = () => {
    if (typeof unsubProgress === "function") { try { unsubProgress(); } catch (_e) { /* */ } }
    if (typeof unsubReport === "function") { try { unsubReport(); } catch (_e) { /* */ } }
    unsubProgress = null;
    unsubReport = null;
    IMPORT_STATE.busy = false;
  };

  unsubProgress = window.api.library.onScanProgress((evt) => {
    if (scanId && evt.scanId !== scanId) return;
    if (evt.phase === "walking") {
      statusEl.textContent = `Scanning files... ${evt.bookFilesFound} books found`;
    } else if (evt.phase === "metadata") {
      statusEl.textContent = `Extracting metadata: ${evt.scannedFiles} / ${evt.totalFiles}`;
    } else if (evt.phase === "dedup") {
      statusEl.textContent = "Analyzing duplicates...";
    }
  });

  unsubReport = window.api.library.onScanReport((payload) => {
    if (scanId && payload.scanId !== scanId) return;
    if (payload.error) {
      statusEl.textContent = `Scan failed: ${payload.error}`;
    } else {
      statusEl.textContent = "";
      renderScanReport(/** @type {any} */ (payload.report), reportContainer);
    }
    cleanup();
  });

  try {
    const res = await window.api.library.scanFolder(folderPath);
    scanId = res.scanId;
  } catch (e) {
    statusEl.textContent = `Scan error: ${e instanceof Error ? e.message : String(e)}`;
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
    el("div", { class: "lib-scan-stat" }, `${report.bookFiles} books found`),
    el("div", { class: "lib-scan-stat" }, `${report.exactDuplicates} exact duplicates (SHA)`),
    el("div", { class: "lib-scan-stat" }, `${report.formatDuplicates} format duplicates`),
    el("div", { class: "lib-scan-stat" }, `${report.fuzzyMatches?.length ?? 0} fuzzy matches`),
    el("div", { class: "lib-scan-stat lib-scan-stat-highlight" }, `~${report.uniqueBooks} unique works`),
  ]);
  container.appendChild(summary);

  if (report.editionGroups && report.editionGroups.length > 0) {
    const edTitle = el("div", { class: "lib-scan-section-title" },
      `Edition/Format Groups (${report.editionGroups.length})`);
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
      `Fuzzy Matches — Review Needed (${report.fuzzyMatches.length})`);
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
