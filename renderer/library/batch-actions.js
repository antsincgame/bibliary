// @ts-check
/**
 * Batch crystallization + synthesis actions for the Catalog bottom-bar.
 */
import { t } from "../i18n.js";
import { showAlert, showConfirm, showPrompt } from "../components/ui-dialog.js";
import { STATE, BATCH, CATALOG } from "./state.js";

/**
 * @param {HTMLElement} root
 * @param {object} deps
 * @param {(root: HTMLElement) => void} deps.renderCatalogTable
 * @param {(root: HTMLElement) => Promise<void>} deps.renderCatalog
 */
export async function guardAndCrystallize(root, deps) {
  if (BATCH.active) return;
  if (CATALOG.selected.size === 0) {
    await showAlert(t("library.catalog.guard.noSelection"));
    return;
  }
  if (!STATE.targetCollection) {
    await showAlert(t("library.catalog.guard.noCollection"));
    return;
  }
  const selectedRows = CATALOG.rows.filter((r) => CATALOG.selected.has(r.id));
  const unevaluated = selectedRows.filter((r) =>
    r.status === "imported" || r.status === "evaluating" || r.status === "failed" ||
    typeof r.qualityScore !== "number"
  );
  if (unevaluated.length > 0) {
    await showAlert(t("library.catalog.guard.unevaluated", { n: String(unevaluated.length) }));
    return;
  }
  const lowQ = selectedRows.filter((r) => (r.qualityScore ?? 0) < 50);
  if (lowQ.length > 0 && !(await showConfirm(t("library.catalog.guard.lowQuality", { n: String(lowQ.length) })))) {
    return;
  }
  void startBatchExtraction(root, selectedRows.map((r) => r.id), deps);
}

/**
 * @param {HTMLElement} root
 * @param {string[]} bookIds
 * @param {object} deps
 */
async function startBatchExtraction(root, bookIds, deps) {
  BATCH.active = true;
  BATCH.batchId = null;
  BATCH.total = bookIds.length;
  BATCH.done = 0;
  BATCH.skipped = 0;
  BATCH.failed = 0;
  BATCH.currentBookId = null;
  BATCH.currentBookTitle = null;
  BATCH.lastJobId = null;
  BATCH.collection = STATE.targetCollection;

  for (const id of bookIds) {
    const idx = CATALOG.rows.findIndex((r) => r.id === id);
    if (idx >= 0) CATALOG.rows[idx].status = "crystallizing";
  }
  updateBatchUi(root);
  deps.renderCatalogTable(root);

  try {
    const res = await window.api.datasetV2.startBatch({
      bookIds,
      targetCollection: STATE.targetCollection,
    });
    await showAlert(t("library.catalog.batch.done", {
      processed: String(res.processed),
      skipped: String(res.skipped.length),
      failed: String(BATCH.failed),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cancelled = /abort|cancel/i.test(msg);
    await showAlert(cancelled
      ? t("library.catalog.batch.cancelled")
      : t("library.catalog.batch.failed", { error: msg }));
  } finally {
    BATCH.active = false;
    BATCH.currentBookId = null;
    BATCH.currentBookTitle = null;
    updateBatchUi(root);
    void deps.renderCatalog(root);
  }
}

export async function cancelBatchExtraction() {
  if (!BATCH.active) return;
  if (!(await showConfirm(t("library.catalog.batch.confirmCancel")))) return;
  if (BATCH.batchId) {
    try { await window.api.datasetV2.cancelBatch(BATCH.batchId); }
    catch (err) { console.warn("[batch.cancelBatch] failed:", err); }
  }
  if (BATCH.lastJobId) {
    try { await window.api.datasetV2.cancel(BATCH.lastJobId); }
    catch (err) { console.warn("[batch.cancel] failed:", err); }
  }
}

/**
 * Dispatcher for `dataset-v2:event` payloads.
 * @param {HTMLElement} root
 * @param {any} ev
 * @param {object} deps
 * @param {(root: HTMLElement) => void} deps.renderCatalogTable
 */
export function applyBatchEvent(root, ev, deps) {
  if (typeof ev.jobId === "string") BATCH.lastJobId = ev.jobId;
  if (typeof ev.batchId === "string") BATCH.batchId = ev.batchId;

  if (ev.stage === "batch") {
    if (ev.phase === "start") {
      BATCH.total = typeof ev.total === "number" ? ev.total : BATCH.total;
    } else if (ev.phase === "filtered") {
      const eligible = typeof ev.eligible === "number" ? ev.eligible : BATCH.total;
      const skipped = typeof ev.skipped === "number" ? ev.skipped : 0;
      BATCH.total = eligible;
      BATCH.skipped += skipped;
    } else if (ev.phase === "book-start") {
      BATCH.currentBookId = typeof ev.bookId === "string" ? ev.bookId : null;
      BATCH.currentBookTitle = typeof ev.bookTitle === "string" ? ev.bookTitle : null;
      if (BATCH.currentBookId) {
        const idx = CATALOG.rows.findIndex((r) => r.id === BATCH.currentBookId);
        if (idx >= 0) CATALOG.rows[idx].status = "crystallizing";
      }
    } else if (ev.phase === "book-done") {
      BATCH.done += 1;
      if (typeof ev.bookId === "string") {
        const idx = CATALOG.rows.findIndex((r) => r.id === ev.bookId);
        if (idx >= 0) CATALOG.rows[idx].status = "indexed";
      }
    } else if (ev.phase === "book-failed") {
      BATCH.failed += 1;
      if (typeof ev.bookId === "string") {
        const idx = CATALOG.rows.findIndex((r) => r.id === ev.bookId);
        if (idx >= 0) CATALOG.rows[idx].status = "failed";
      }
    }
    updateBatchUi(root);
    deps.renderCatalogTable(root);
  }
}

/** @param {HTMLElement} root */
export function updateBatchUi(root) {
  const btn = root.querySelector(".lib-catalog-bottombar .lib-btn-primary");
  const cancelBtn = root.querySelector(".lib-catalog-bottombar .lib-btn-cancel-batch");
  const summary = root.querySelector(".lib-catalog-batch-summary");

  if (btn) {
    if (BATCH.active) {
      btn.setAttribute("disabled", "true");
      btn.classList.add("lib-btn-busy");
      btn.textContent = t("library.catalog.batch.progress", {
        done: String(BATCH.done),
        total: String(BATCH.total),
        skipped: String(BATCH.skipped),
      });
    } else {
      btn.removeAttribute("disabled");
      btn.classList.remove("lib-btn-busy");
      btn.textContent = t("library.catalog.btn.createChunks");
    }
  }
  if (cancelBtn) {
    /** @type {HTMLElement} */ (cancelBtn).style.display = BATCH.active ? "" : "none";
  }
  if (summary) {
    summary.textContent = BATCH.active && BATCH.currentBookTitle
      ? t("library.catalog.batch.book", {
          title: BATCH.currentBookTitle,
          i: String(BATCH.done + 1),
          total: String(BATCH.total),
        })
      : "";
  }
}

export async function launchSynthesis() {
  if (!STATE.targetCollection) {
    await showAlert(t("library.catalog.guard.noCollection"));
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const safeColl = STATE.targetCollection.replace(/[^a-z0-9-]/gi, "_");
  const defaultOut = `release/datasets/${safeColl}-${stamp}.jsonl`;

  const outputPath = await showPrompt(
    t("library.catalog.synth.promptOutput", { coll: STATE.targetCollection }),
    defaultOut,
  );
  if (!outputPath) return;

  const pairsRaw = await showPrompt(t("library.catalog.synth.promptPairs"), "2");
  if (!pairsRaw) return;
  const pairsPerConcept = Math.max(1, Math.min(5, parseInt(pairsRaw, 10) || 2));

  const includeReasoning = await showConfirm(t("library.catalog.synth.confirmReasoning"));

  const startConfirmed = await showConfirm(
    t("library.catalog.synth.confirmStart", {
      coll: STATE.targetCollection,
      out: outputPath,
      pairs: String(pairsPerConcept),
      reasoning: includeReasoning ? "yes" : "no",
    }),
  );
  if (!startConfirmed) return;

  try {
    const res = await window.api.datasetV2.synthesize({
      collection: STATE.targetCollection,
      outputPath,
      pairsPerConcept,
      includeReasoning,
    });
    await showAlert(t("library.catalog.synth.done", {
      pairs: String(res?.totalPairs ?? 0),
      out: outputPath,
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await showAlert(t("library.catalog.synth.failed", { error: msg }));
  }
}
