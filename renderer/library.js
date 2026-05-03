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
import { loadPrefs } from "./library/browse.js";
import { buildCatalogPane, renderCatalog, renderCatalogTable, highlightCatalogBookRow, cleanupCoverObserver } from "./library/catalog.js";
import { buildImportPane, renderImport, pushImportPaneLog } from "./library/import-pane.js";
import { mountCollectionViews } from "./library/collection-views.js";
import { refreshEvaluatorState } from "./library/evaluator.js";
import { applyBatchEvent } from "./library/batch-actions.js";
import { renderSearch, subscribeDownloadProgress } from "./library/search.js";
import { closeReader, isReaderOpen, openBook } from "./library/reader.js";

function switchTab(tab, root) {
  if (tab !== "catalog" && isReaderOpen()) {
    const catalogPane = /** @type {HTMLElement|null} */ (root.querySelector(".lib-pane-catalog"));
    if (catalogPane) closeReader(catalogPane);
  }
  STATE.tab = tab;
  root.querySelectorAll(".lib-tab").forEach((b) => {
    b.classList.toggle("lib-tab-active", b.dataset.tab === tab);
  });
  root.querySelector(".lib-pane-catalog")?.classList.toggle("lib-pane-active", tab === "catalog");
  root.querySelector(".lib-pane-import")?.classList.toggle("lib-pane-active", tab === "import");
  root.querySelector(".lib-pane-search")?.classList.toggle("lib-pane-active", tab === "search");
  root.querySelector(".lib-pane-collections")?.classList.toggle("lib-pane-active", tab === "collections");
  if (tab === "search") renderSearch(root);
  if (tab === "catalog") void renderCatalog(root);
  if (tab === "import") renderImport(root);
  if (tab === "collections") activateCollectionsPane(root);
}

function activateCollectionsPane(root) {
  const pane = /** @type {HTMLElement|null} */ (root.querySelector(".lib-pane-collections"));
  if (!pane || pane.dataset.mounted) return;
  pane.dataset.mounted = "1";
  mountCollectionViews(pane, (bookIds) => {
    CATALOG.filters.filterBookIds = bookIds.length > 0 ? new Set(bookIds) : null;
    switchTab("catalog", root);
    renderCatalogTable(root);
  });
}

function buildLibraryTabs(root) {
  return el("div", { class: "lib-tabs" }, [
    el("button", { class: "lib-tab lib-tab-active", type: "button", "data-tab": "import",
      onclick: () => switchTab("import", root) }, t("library.tab.import")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "catalog",
      onclick: () => switchTab("catalog", root) }, t("library.tab.catalog")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "collections",
      title: t("library.tab.collections.tooltip"),
      onclick: () => switchTab("collections", root) }, t("library.tab.collections")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "search",
      title: t("library.tab.hunt.tooltip"),
      onclick: () => switchTab("search", root) }, t("library.tab.hunt")),
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
    /* Иt 8Е.2 (симметрия удаления, 2026-05-02): добавлена кнопка «−» в picker.
       Backend qdrant:delete-collection уже работает с момента Crystal wizard.
       Теперь Library top bar тоже умеет удалять коллекции — чтобы пользователь
       не нырял в Crystal вкладку для destructive операции. */
    onDelete: async (name) => {
      try {
        await window.api.qdrant.remove(name);
        if (STATE.targetCollection === name) {
          STATE.targetCollection = "";
          STATE.collection = "";
        }
      } catch (e) {
        console.error("[library.collection.delete]", name, e);
        throw e;
      }
    },
  });

  /* Quick-jump: создать датасет из выбранной коллекции прямо отсюда. Кладём
     имя коллекции в sessionStorage и переключаем sidebar на Crystal — там
     mountCrystal подхватит pre-fill при первом монтировании / re-mount. */
  const goCreateBtn = el("button", {
    class: "lib-btn lib-btn-accent lib-collection-go-create",
    type: "button",
    title: t("library.collection.goCreate.title"),
    onclick: () => {
      const name = STATE.targetCollection || STATE.collection || "";
      if (!name) return;
      try {
        sessionStorage.setItem("bibliary_dataset_prefill_collection", name);
      } catch { /* private mode */ }
      const crystalRoot = document.getElementById("crystal-root");
      if (crystalRoot) {
        delete crystalRoot.dataset.mounted;
        crystalRoot.innerHTML = "";
      }
      const trigger = /** @type {HTMLButtonElement | null} */ (
        document.querySelector('.sidebar-icon[data-route="crystal"]')
      );
      trigger?.click();
    },
  }, t("library.collection.goCreate"));

  return el("div", { class: "lib-topbar" }, [
    header,
    el("div", { class: "lib-topbar-row" }, [picker.root, goCreateBtn]),
  ]);
}

function installWindowDropGuards(root) {
  if (root.dataset.dropGuard) return;
  root.dataset.dropGuard = "1";
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => ev.preventDefault());
}

async function focusCatalogBook(root, bookId) {
  if (!bookId) return;
  if (STATE.tab !== "catalog") switchTab("catalog", root);
  await renderCatalog(root);
  highlightCatalogBookRow(root, bookId);
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

  const catalogPane = buildCatalogPane(root, catalogDeps);
  catalogPane.classList.remove("lib-pane-active");
  const importPane = buildImportPane({ renderCatalog, focusCatalogBook: (bookId) => focusCatalogBook(root, bookId) });
  importPane.classList.add("lib-pane-active");
  STATE.tab = "import";

  const searchPane = el("div", { class: "lib-pane lib-pane-search" }, [el("div", { class: "lib-search" })]);
  const collectionsPane = el("div", { class: "lib-pane lib-pane-collections" });

  const layout = el("div", { class: "lib-page-layout" }, [topBar, tabs, importPane, catalogPane, searchPane, collectionsPane]);
  root.append(layout);

  if (typeof CATALOG.unsubEvaluator === "function") CATALOG.unsubEvaluator();
  if (typeof CATALOG.unsubBatch === "function") CATALOG.unsubBatch();
  if (typeof CATALOG._unsubDownload === "function") CATALOG._unsubDownload();

  CATALOG._unsubDownload = subscribeDownloadProgress(root);
  installWindowDropGuards(root);

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
    if (ev && ev.stage === "config" && ev.phase === "delta-models") {
      const chainArr = Array.isArray(ev.extractModelChain) ? ev.extractModelChain : [];
      const chainText = chainArr.join(" → ");
      const cross = Boolean(ev.deltaCrossModel);
      const msg = cross
        ? t("library.extraction.deltaChain", { chain: chainText })
        : t("library.extraction.deltaChainSingle", { model: String(ev.extractModel ?? chainArr[0] ?? "") });
      pushImportPaneLog({
        level: "info",
        category: "extraction.delta-models",
        message: msg,
        details: {
          extractModel: ev.extractModel,
          extractModelChain: chainArr,
          rawDeltaChain: ev.rawDeltaChain,
          deltaCrossModel: ev.deltaCrossModel,
        },
      });
    }
  });

  void renderCatalog(root);
  renderImport(root);
  checkPendingLibraryNav(root);
}

export function isLibraryBusy() {
  return STATE.activeIngests.size > 0 || STATE.queue.length > 0;
}

/**
 * Cleanup all active subscriptions and the cover IntersectionObserver.
 * Called by router.js before unmounting (locale switch / remount).
 */
export function unmountLibrary() {
  if (typeof CATALOG.unsubEvaluator === "function") {
    CATALOG.unsubEvaluator();
    CATALOG.unsubEvaluator = null;
  }
  if (typeof CATALOG.unsubBatch === "function") {
    CATALOG.unsubBatch();
    CATALOG.unsubBatch = null;
  }
  if (typeof CATALOG._unsubDownload === "function") {
    CATALOG._unsubDownload();
    CATALOG._unsubDownload = null;
  }
  cleanupCoverObserver();
}

/**
 * Handle cross-route navigation payload from Search page.
 * If sessionStorage contains "bibliary_open_book_id", switch to catalog,
 * render, and open the reader for that book.
 *
 * Called both at mount-time and when the library route is re-shown while
 * already mounted (router.js showRoute hook).
 *
 * @param {HTMLElement|null} root
 */
export function checkPendingLibraryNav(root) {
  if (!root) return;
  let bookId = null;
  try {
    bookId = sessionStorage.getItem("bibliary_open_book_id");
    if (bookId) sessionStorage.removeItem("bibliary_open_book_id");
  } catch { /* private/restricted mode */ }
  if (!bookId) return;
  if (STATE.tab !== "catalog") switchTab("catalog", root);
  void renderCatalog(root).then(() => {
    const pane = /** @type {HTMLElement|null} */ (root.querySelector(".lib-pane-catalog"));
    if (pane) openBook(bookId, pane);
    else highlightCatalogBookRow(root, bookId);
  });
}
