// @ts-check
/**
 * Library page — thin coordinator.
 *
 * Domain modules in renderer/library/:
 *   state.js          — shared mutable state objects
 *   browse.js         — pref loader (loadPrefs)
 *   catalog.js        — catalog table, toolbar, bottom-bar
 *   import-pane.js    — import from folder/files, live progress
 *   evaluator.js      — evaluator panel UI
 *   batch-actions.js  — crystallization + synthesis
 *   format.js         — formatting helpers
 *   catalog-filter.js — filter/quality helpers
 *   reader.js         — debug reader (markdown + images)
 */
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";

import { STATE, CATALOG } from "./library/state.js";
import { loadPrefs } from "./library/browse.js";
import { buildCatalogPane, renderCatalog, renderCatalogTable, highlightCatalogBookRow, cleanupCoverObserver } from "./library/catalog.js";
import { buildImportPane, renderImport, pushImportPaneLog } from "./library/import-pane.js";
import { mountCollectionViews } from "./library/collection-views.js";
import { refreshEvaluatorState } from "./library/evaluator.js";
import { applyBatchEvent } from "./library/batch-actions.js";
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
  root.querySelector(".lib-pane-collections")?.classList.toggle("lib-pane-active", tab === "collections");
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

  const tabs = buildLibraryTabs(root);

  const catalogPane = buildCatalogPane(root, catalogDeps);
  catalogPane.classList.remove("lib-pane-active");
  const importPane = buildImportPane({ renderCatalog, focusCatalogBook: (bookId) => focusCatalogBook(root, bookId) });
  importPane.classList.add("lib-pane-active");
  STATE.tab = "import";

  const collectionsPane = el("div", { class: "lib-pane lib-pane-collections" });

  const layout = el("div", { class: "lib-page-layout" }, [tabs, importPane, catalogPane, collectionsPane]);
  root.append(layout);

  if (typeof CATALOG.unsubEvaluator === "function") CATALOG.unsubEvaluator();
  if (typeof CATALOG.unsubExtractor === "function") CATALOG.unsubExtractor();
  if (typeof CATALOG.unsubBatch === "function") CATALOG.unsubBatch();

  installWindowDropGuards(root);

  /**
   * Phase 6f split: evaluator events (POST /evaluate) и extractor events
   * (POST /extract) идут на разные SSE channels. Тот же callback
   * рефрешит UI на обоих — book row может изменить score (evaluator)
   * или статус indexed/failed (extractor).
   */
  const onPipelineEvent = (ev) => {
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
    /* Δ-ui-a — log Δ-topology counters when an extraction finishes.
     * The bridge emits a single 'done' event per book with the full
     * tally; surface it in the import-pane log so users see how much
     * structure was produced beyond the headline conceptsAccepted. */
    const p = ev && ev.payload;
    if (ev && ev.event === "done" && p && p.kind === "extraction") {
      const parts = [];
      if (typeof p.conceptsAccepted === "number") {
        parts.push(`${p.conceptsAccepted} concepts`);
      }
      if (typeof p.chunksTotal === "number") {
        parts.push(`${p.chunksTotal} L1 chunks`);
      }
      if (typeof p.entitiesTouched === "number" && p.entitiesTouched > 0) {
        parts.push(`${p.entitiesTouched} entities`);
      }
      if (typeof p.relationsInserted === "number" && p.relationsInserted > 0) {
        parts.push(`${p.relationsInserted} relations`);
      }
      if (typeof p.propositionsInserted === "number" && p.propositionsInserted > 0) {
        parts.push(`${p.propositionsInserted} propositions`);
      }
      if (parts.length > 0) {
        pushImportPaneLog({
          level: "info",
          category: "extraction.topology",
          message: `Topology: ${parts.join(" · ")}`,
          details: {
            bookId: ev.bookId,
            chaptersProcessed: p.chaptersProcessed,
            conceptsAccepted: p.conceptsAccepted,
            conceptsFailed: p.conceptsFailed,
            entitiesTouched: p.entitiesTouched,
            relationsInserted: p.relationsInserted,
            propositionsInserted: p.propositionsInserted,
            usingFallback: p.usingFallback,
          },
        });
      }
    }
    /* Phase 9 — surface the batch:filtered SSE so users immediately
     * see "queued 27/30, skipped 3" instead of waiting for first
     * child job to start. */
    if (ev && ev.event === "batch:filtered" && p && p.kind === "batch") {
      pushImportPaneLog({
        level: "info",
        category: "extraction.batch",
        message: `Batch → '${p.collection}': ${p.eligible}/${p.total} eligible, ${p.skipped} skipped (minQuality ${p.minQuality})`,
        details: { batchId: ev.batchId, ...p },
      });
    }
  };
  CATALOG.unsubEvaluator = window.api.library.onEvaluatorEvent(onPipelineEvent);
  if (typeof window.api.library.onExtractorEvent === "function") {
    CATALOG.unsubExtractor = window.api.library.onExtractorEvent(onPipelineEvent);
  }

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
  if (typeof CATALOG.unsubExtractor === "function") {
    CATALOG.unsubExtractor();
    CATALOG.unsubExtractor = null;
  }
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
