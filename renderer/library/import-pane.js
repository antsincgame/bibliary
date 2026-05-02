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

  /* Иt 8Е.4 (cancel import UI): кнопка показывается только во время импорта.
     Backend library:cancel-import уже работает — preload bridge тоже готов. */
  const cancelImportBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-danger lib-import-cancel",
    style: "display: none",
    onclick: async () => {
      const { showConfirm } = await import("../components/ui-dialog.js");
      if (!(await showConfirm(t("library.import.cancel.confirm")))) return;
      try {
        const id = IMPORT_STATE.importId;
        if (id) await window.api.library.cancelImport(id);
      } catch (err) {
        console.warn("[import.cancel] failed:", err);
      }
    },
  }, t("library.import.btn.cancel"));

  /* Иt 8Е.5 (rebuild cache UI): preload-мост library.rebuildCache возвращён
     в этой итерации (см. preload.ts). Кнопка скромно расположена — это
     операция для "когда что-то странное случилось", не повседневная. */
  const rebuildCacheBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost lib-import-rebuild-cache",
    title: t("library.catalog.btn.rebuild.tooltip"),
    onclick: async () => {
      const { showConfirm, showAlert } = await import("../components/ui-dialog.js");
      if (!(await showConfirm(t("library.catalog.btn.rebuild.confirm")))) return;
      try {
        const r = await window.api.library.rebuildCache();
        await showAlert(t("library.catalog.btn.rebuild.done", {
          ingested: String(r.ingested ?? 0),
          pruned: String(r.pruned ?? 0),
          errors: String((r.errors ?? []).length),
        }));
      } catch (err) {
        console.warn("[catalog.rebuildCache] failed:", err);
        await showAlert(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }, t("library.catalog.btn.rebuild"));


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
    el("div", { class: "lib-import-actions" }, [
      pickFolderBtn, pickFilesBtn, cancelImportBtn, rebuildCacheBtn,
    ]),
    opts,
    status,
    logPanel,
    evaluatorPanel,
  ]);

  /* Иt 8Е.4: показывать cancel-кнопку только когда импорт активен.
     Polling каждые 500ms — IMPORT_STATE мутируется в import-pane-actions без
     событий. Нет добавления новых deps; стандартный pattern для UI sync. */
  const updateCancelVisibility = () => {
    cancelImportBtn.style.display =
      IMPORT_STATE.busy && IMPORT_STATE.importId ? "" : "none";
  };
  updateCancelVisibility();
  const cancelPoller = setInterval(updateCancelVisibility, 500);
  /* Cleanup при размонтировании body — слушаем DOMNodeRemoved (mostly
     deprecated, но Electron поддерживает). Альтернатива — MutationObserver,
     но для одного панель-rebuild interval acceptable. */
  body.addEventListener("DOMNodeRemoved", (ev) => {
    if (ev.target === body) clearInterval(cancelPoller);
  });

  return el("div", { class: "lib-pane lib-pane-import" }, [body]);
}

/** @param {HTMLElement} root */
export function renderImport(root) {
  void refreshEvaluatorState(root);
  /* При открытии вкладки тянем snapshot лога — даже если импорт не идёт сейчас,
     юзер увидит, что было в прошлой сессии (включая краш-причины). */
  void hydrateLogSnapshot();
}
