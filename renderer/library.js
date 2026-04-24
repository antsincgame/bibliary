// @ts-check
/**
 * Library page — thin coordinator.
 *
 * All domain logic lives in renderer/library/ modules:
 *   state.js        — shared mutable state objects
 *   browse.js       — file picker, queue, preview, drag-drop, history
 *   catalog.js      — catalog table, toolbar, bottom-bar
 *   import-pane.js  — import from folder/files, live progress
 *   evaluator.js    — evaluator panel UI
 *   batch-actions.js— crystallization + synthesis
 *   search.js       — BookHunter online search + download
 *   format.js       — formatting helpers (pre-existing)
 *   catalog-filter.js — filter/quality helpers (pre-existing)
 */
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildCollectionPicker } from "./components/collection-picker.js";

import { STATE, CATALOG } from "./library/state.js";
import {
  loadPrefs, loadCollections, loadHistory,
  renderBooks, renderPreview, refreshSummary,
  buildDropzone, buildGroupControl, buildCollectionInput,
  buildLibrarySummary, buildOcrBadge, buildLibraryActionButtons,
  renderHistory,
} from "./library/browse.js";
import { buildCatalogPane, renderCatalog, renderCatalogTable } from "./library/catalog.js";
import { buildImportPane, renderImport } from "./library/import-pane.js";
import { refreshEvaluatorState } from "./library/evaluator.js";
import { applyBatchEvent } from "./library/batch-actions.js";
import { renderSearch, subscribeDownloadProgress } from "./library/search.js";

function switchTab(tab, root) {
  STATE.tab = tab;
  root.querySelectorAll(".lib-tab").forEach((b) => {
    b.classList.toggle("lib-tab-active", b.dataset.tab === tab);
  });
  root.querySelector(".lib-pane-catalog")?.classList.toggle("lib-pane-active", tab === "catalog");
  root.querySelector(".lib-pane-import")?.classList.toggle("lib-pane-active", tab === "import");
  root.querySelector(".lib-pane-browse")?.classList.toggle("lib-pane-active", tab === "browse");
  root.querySelector(".lib-pane-history")?.classList.toggle("lib-pane-active", tab === "history");
  root.querySelector(".lib-pane-search")?.classList.toggle("lib-pane-active", tab === "search");
  if (tab === "history") loadHistory().then(() => renderHistory(root));
  if (tab === "search") renderSearch(root);
  if (tab === "catalog") void renderCatalog(root);
  if (tab === "import") renderImport(root);
}

function buildLibraryTabs(root) {
  /* Порядок вкладок (Phase 7 UX-правки):
       Импорт → Каталог → Найти онлайн → Прямая индексация → История.
     Работа начинается с Импорта (см. UX-фидбек пользователя): сперва книги
     попадают в каталог, а затем уже просматриваются. «Прямая индексация»
     (бывший «RAG Ingest», data-tab="browse") — низкоуровневый путь
     scanner.startIngest → Qdrant без копирования в каталог; оставлен для
     отладки и точечных операций. */
  return el("div", { class: "lib-tabs" }, [
    el("button", { class: "lib-tab lib-tab-active", type: "button", "data-tab": "import",
      onclick: () => switchTab("import", root) }, t("library.tab.import")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "catalog",
      onclick: () => switchTab("catalog", root) }, t("library.tab.catalog")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "search",
      title: t("library.tab.hunt.tooltip"),
      onclick: () => switchTab("search", root) }, t("library.tab.hunt")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "browse",
      title: t("library.tab.ingest.tooltip"),
      onclick: () => switchTab("browse", root) }, t("library.tab.ingest")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "history",
      onclick: () => switchTab("history", root) }, t("library.tab.history")),
  ]);
}

function buildLibraryTopBar(root) {
  const header = el("div", { class: "lib-topbar-header" }, [
    el("div", { class: "lib-topbar-title" }, t("library.header.title")),
    el("div", { class: "lib-topbar-sub" }, t("library.header.sub")),
  ]);

  const picker = buildCollectionPicker({
    id: "lib-target-collection",
    labelText: t("library.collection.target"),
    onChange: (name) => {
      STATE.targetCollection = name;
      STATE.collection = name;
      const legacyInput = /** @type {HTMLInputElement|null} */ (root.querySelector(".lib-collection-input"));
      if (legacyInput && legacyInput.value !== name) legacyInput.value = name;
    },
    onCreate: () => { /* picker.refresh already called */ },
    loadCollections: async () => {
      try { return await window.api.getCollections(); } catch { return []; }
    },
    createCollection: async (name) => {
      try {
        const r = /** @type {any} */ (await window.api.qdrant.create({ name }));
        if (!r || r.ok === false) return { ok: false, error: r?.error || "unknown" };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
  void picker.refresh();

  return el("div", { class: "lib-topbar" }, [header, picker.root]);
}

function subscribeScannerProgress(root, listEl) {
  return window.api.scanner.onProgress((p) => {
    STATE.progress.set(p.bookSourcePath, p);
    renderBooks(listEl, root);
  });
}

function installWindowDropGuards(root) {
  if (root.dataset.dropGuard) return;
  root.dataset.dropGuard = "1";
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => ev.preventDefault());
}

function loadInitialLibraryData(root, datalist, collectionInput) {
  Promise.all([loadCollections(), loadHistory()]).then(() => {
    clear(datalist);
    for (const c of STATE.collections) datalist.appendChild(el("option", { value: c }));
    if (!STATE.collection) {
      collectionInput.value = "library";
      STATE.collection = "library";
    }
    renderBooks(root.querySelector(".lib-list"), root);
  });
}

export async function mountLibrary(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  await loadPrefs();

  const catalogDeps = { renderCatalog, renderCatalogTable };

  const topBar = buildLibraryTopBar(root);
  const tabs = buildLibraryTabs(root);
  const coll = buildCollectionInput();
  const listEl = el("div", { class: "lib-list" });
  const previewEl = el("div", { class: "lib-preview" });
  const btns = buildLibraryActionButtons(root, listEl);
  const groupControl = buildGroupControl(root, listEl);

  const toolbar = el("div", { class: "lib-toolbar" }, [
    coll.wrap, btns.btnPick, btns.btnOpenFiles, btns.btnStart, btns.btnCancel,
    groupControl, buildOcrBadge(), buildLibrarySummary(),
  ]);
  const dropzone = buildDropzone(root, listEl);
  const splitPane = el("div", { class: "lib-split" }, [listEl, previewEl]);

  /* Каталог теперь не активен по умолчанию: работа начинается с Импорта.
     buildCatalogPane исторически ставит lib-pane-active — снимаем его и
     активируем lib-pane-import вручную ниже. */
  const catalogPane = buildCatalogPane(root, catalogDeps);
  catalogPane.classList.remove("lib-pane-active");
  const importPane = buildImportPane({ renderCatalog });
  importPane.classList.add("lib-pane-active");
  STATE.tab = "import";

  const browseHint = el("div", { class: "lib-browse-hint" }, t("library.tab.ingest.hint"));
  const browsePane = el("div", { class: "lib-pane lib-pane-browse" }, [browseHint, toolbar, dropzone, splitPane]);
  const searchPane = el("div", { class: "lib-pane lib-pane-search" }, [el("div", { class: "lib-search" })]);
  const historyPane = el("div", { class: "lib-pane lib-pane-history" }, [el("div", { class: "lib-history" })]);

  root.append(topBar, tabs, importPane, catalogPane, browsePane, searchPane, historyPane);

  const _unsubScanner = subscribeScannerProgress(root, listEl);
  const _unsubDownload = subscribeDownloadProgress(root);
  installWindowDropGuards(root);
  loadInitialLibraryData(root, coll.datalist, coll.input);

  CATALOG.unsubEvaluator = window.api.library.onEvaluatorEvent((ev) => {
    if (STATE.tab === "catalog") void renderCatalog(root);
    if (STATE.tab === "import") void refreshEvaluatorState(root);
    if (ev.bookId && STATE.tab !== "catalog" && STATE.tab !== "import") {
      const idx = CATALOG.rows.findIndex((r) => r.id === ev.bookId);
      if (idx >= 0 && typeof ev.qualityScore === "number") {
        CATALOG.rows[idx].qualityScore = ev.qualityScore;
        if (typeof ev.isFictionOrWater === "boolean") {
          CATALOG.rows[idx].isFictionOrWater = ev.isFictionOrWater;
        }
      }
    }
  });

  CATALOG.unsubBatch = window.api.datasetV2.onEvent((ev) => {
    applyBatchEvent(root, ev, catalogDeps);
  });

  refreshSummary(root);
  renderPreview(root);
  renderBooks(listEl, root);

  /* Каталог всё равно прелоадим: если пользователь сразу переключится — таблица уже готова.
     Импорт-панель показывается первой через CSS .lib-pane-active. */
  void renderCatalog(root);
  renderImport(root);
}

export function isLibraryBusy() {
  return STATE.activeIngests.size > 0 || STATE.queue.length > 0;
}
