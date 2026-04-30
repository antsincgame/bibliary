// @ts-check
/**
 * Import pane: folder/file import with live progress and evaluator panel.
 *
 * Декомпозиция (Phase 3.4 cross-platform roadmap, 2026-04-30):
 *   - `import-pane-log.js`     — лог-панель с фильтром/счётчиками/copy
 *   - `import-pane-actions.js` — pickFolder/Files, bundle, runImport, DnD, scan
 *
 * В этом файле остаются: `buildImportPane` (DOM-сборка карточки), `renderImport`
 * (re-mount hook) и публичный re-export `pushImportPaneLog` для dataset-v2.
 */

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { IMPORT_STATE } from "./state.js";
import { buildEvaluatorPanel, refreshEvaluatorState } from "./evaluator.js";
import { showLibraryToast } from "./toast.js";
import { buildLogPanel, hydrateLogSnapshot } from "./import-pane-log.js";
import {
  importFromFolder,
  importFromFiles,
  installImportDropHandlers,
} from "./import-pane-actions.js";

export { pushImportPaneLog } from "./import-pane-log.js";

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
  const recursiveCb = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    class: "lib-import-cb",
    checked: IMPORT_STATE.recursive ? "checked" : undefined,
  }));
  recursiveCb.addEventListener("change", () => { IMPORT_STATE.recursive = recursiveCb.checked; });

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

  const pauseBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-pause",
    style: "display:none",
    onclick: async () => {
      const isPaused = pauseBtn.dataset.paused === "1";
      try {
        if (isPaused) {
          await window.api.library.evaluatorResume();
          pauseBtn.dataset.paused = "0";
          pauseBtn.textContent = t("library.import.btn.pause");
        } else {
          await window.api.library.evaluatorPause();
          pauseBtn.dataset.paused = "1";
          pauseBtn.textContent = t("library.import.btn.resume");
        }
      } catch (_e) { console.warn("[import] pause/resume failed:", _e); }
    },
  }, t("library.import.btn.pause"));

  const cancelBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-cancel",
    style: "display:none",
    onclick: async () => {
      if (IMPORT_STATE.importId) {
        try { await window.api.library.cancelImport(IMPORT_STATE.importId); }
        catch (_e) {
          console.warn("[import] cancelImport failed:", _e);
          showLibraryToast({ kind: "error", message: t("library.import.cancelFailed") });
        }
      }
    },
  }, t("library.import.btn.cancel"));

  const opts = el("div", { class: "lib-import-opts" }, [
    el("label", { class: "lib-import-opt", title: t("library.import.opt.tooltip.scanArchives") }, [
      archiveCb, t("library.import.opt.scanArchives"),
    ]),
    el("label", { class: "lib-import-opt" }, [
      recursiveCb, t("library.import.opt.recursive"),
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
  installImportDropHandlers(dropzone, deps);

  const status = el("div", { class: "lib-import-status", "aria-live": "polite" }, "");
  const logPanel = buildLogPanel();

  const evaluatorPanel = buildEvaluatorPanel();

  const body = el("div", { class: "lib-import-body" }, [
    dropzone,
    el("div", { class: "lib-import-actions" }, [pickFolderBtn, pickFilesBtn, pauseBtn, cancelBtn]),
    opts,
    status,
    logPanel,
    evaluatorPanel,
  ]);

  return el("div", { class: "lib-pane lib-pane-import" }, [body]);
}

/** @param {HTMLElement} root */
export function renderImport(root) {
  void refreshEvaluatorState(root);
  /* При открытии вкладки тянем snapshot лога — даже если импорт не идёт сейчас,
     юзер увидит, что было в прошлой сессии (включая краш-причины). */
  void hydrateLogSnapshot();
}
