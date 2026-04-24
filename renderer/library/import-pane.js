// @ts-check
/**
 * Import pane: folder/file import with live progress and evaluator panel.
 */
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { IMPORT_STATE } from "./state.js";
import { buildEvaluatorPanel, refreshEvaluatorState } from "./evaluator.js";

/**
 * @param {object} deps
 * @param {(root: HTMLElement) => Promise<void>} deps.renderCatalog
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

  const body = el("div", { class: "lib-import-body" }, [
    dropzone,
    el("div", { class: "lib-import-actions" }, [pickFolderBtn, pickFilesBtn, cancelBtn]),
    opts,
    status,
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
  } catch (_e) { console.warn("[import] probeFiles failed:", _e); paths = []; }
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
        const discovered = Number(evt?.discovered ?? 0);
        const processed = Number(evt?.processed ?? 0);
        if (evt?.phase === "processed") {
          status.textContent = t("library.import.progress.copying", {
            done: String(processed),
            total: String(Math.max(discovered, processed)),
          });
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
