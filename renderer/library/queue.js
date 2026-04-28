// @ts-check
/**
 * Queue runner: enqueue books for ingestion, pump with parallelism.
 */
import { t } from "../i18n.js";
import { showAlert } from "../components/ui-dialog.js";
import { STATE } from "./state.js";

/**
 * @param {object} deps
 * @param {(root: HTMLElement) => void} deps.refreshSummary
 * @param {(listEl: HTMLElement|null, root: HTMLElement) => void} deps.renderBooks
 */

/**
 * @param {import("./state.js").BookFile[]} books
 * @param {HTMLElement} root
 * @param {object} deps
 * @param {(root: HTMLElement) => void} deps.refreshSummary
 * @param {(listEl: HTMLElement|null, root: HTMLElement) => void} deps.renderBooks
 */
export function enqueueAndStart(books, root, deps) {
  for (const b of books) {
    if (STATE.queue.find((x) => x.absPath === b.absPath)) continue;
    if (STATE.activeIngests.has(b.absPath)) continue;
    STATE.queue.push(b);
  }
  deps.refreshSummary(root);
  pumpQueue(root, deps);
}

/** @param {HTMLElement} root */
async function pumpQueue(root, deps) {
  if (STATE.paused) return;
  while (STATE.activeIngests.size < STATE.prefs.queueParallelism && STATE.queue.length > 0) {
    const next = STATE.queue.shift();
    if (!next) break;
    if (!STATE.collection) {
      await showAlert(t("library.alert.collection"));
      STATE.queue.unshift(next);
      return;
    }
    runOne(next, root, deps);
  }
  deps.refreshSummary(root);
}

async function runOne(book, root, deps) {
  STATE.activeIngests.set(book.absPath, "pending");
  try {
    const ocrOverride = STATE.ocrOverride !== null ? STATE.ocrOverride : undefined;
    const res = await window.api.scanner.startIngest({
      filePath: book.absPath,
      collection: STATE.collection,
      ocrOverride,
    });
    STATE.activeIngests.set(book.absPath, res.ingestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    STATE.progress.set(book.absPath, {
      ingestId: "",
      phase: "error",
      bookSourcePath: book.absPath,
      bookTitle: book.fileName,
      totalChunks: 0,
      processedChunks: 0,
      embeddedChunks: 0,
      upsertedChunks: 0,
      errorMessage: msg,
    });
  } finally {
    STATE.activeIngests.delete(book.absPath);
    deps.renderBooks(root.querySelector(".lib-list"), root);
    deps.refreshSummary(root);
    pumpQueue(root, deps);
  }
}

/** @param {HTMLElement} root */
export async function cancelAll(root, deps) {
  STATE.paused = true;
  STATE.queue.length = 0;
  for (const [, id] of STATE.activeIngests) {
    if (id && id !== "pending") {
      try { await window.api.scanner.cancelIngest(id); } catch (_e) { console.warn("[queue] cancelIngest failed:", _e); }
    }
  }
  STATE.activeIngests.clear();
  deps.refreshSummary(root);
  STATE.paused = false;
}
