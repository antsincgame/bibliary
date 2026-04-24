// @ts-check
/**
 * Browse tab: file list, grouping, dropzone, action buttons, OCR badge.
 *
 * Sub-domains extracted into:
 *   history.js  — loadHistory, renderHistory
 *   preview.js  — selectForPreview, renderPreview, OCR hints
 *   queue.js    — enqueueAndStart, pumpQueue, runOne, cancelAll
 */
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { STATE } from "./state.js";
import { fmtMB } from "./format.js";
import { selectForPreview } from "./preview.js";
import { enqueueAndStart, cancelAll } from "./queue.js";
import { loadHistory } from "./history.js";

export { loadHistory } from "./history.js";
export { renderHistory } from "./history.js";
export { renderPreview } from "./preview.js";
export { loadCollections, loadPrefs };

function extBadge(ext) {
  const norm = String(ext || "").toLowerCase();
  return el("span", { class: `lib-ext lib-ext-${norm}` }, norm.toUpperCase());
}

function statusForBook(book) {
  const prog = STATE.progress.get(book.absPath);
  const known = STATE.knownPaths.has(book.absPath);
  if (!prog && known) return el("span", { class: "lib-status lib-status-known" }, t("library.status.alreadyIngested"));
  if (!prog) return el("span", { class: "lib-status lib-status-pending" }, t("library.status.pending"));
  if (prog.phase === "done") return el("span", { class: "lib-status lib-status-done" }, t("library.status.done"));
  if (prog.phase === "error") return el("span", { class: "lib-status lib-status-error" }, prog.errorMessage || t("library.status.error"));
  const pct = prog.totalChunks > 0 ? Math.floor((prog.processedChunks / prog.totalChunks) * 100) : 0;
  return el("span", { class: "lib-status lib-status-running" }, `${prog.phase} ${pct}% (${prog.processedChunks}/${prog.totalChunks})`);
}

function statusKeyForBook(book) {
  const prog = STATE.progress.get(book.absPath);
  const known = STATE.knownPaths.has(book.absPath);
  if (prog?.phase === "done") return "done";
  if (prog?.phase === "error") return "error";
  if (prog) return "running";
  if (known) return "known";
  return "pending";
}

export function refreshSummary(root) {
  const sel = root.querySelector("#lib-selected-count");
  if (sel) sel.textContent = String(STATE.selected.size);
  const total = root.querySelector("#lib-total-count");
  if (total) total.textContent = String(STATE.books.length);
  const queueLen = root.querySelector("#lib-queue-count");
  if (queueLen) queueLen.textContent = String(STATE.queue.length + STATE.activeIngests.size);
}

/** Deps bundle passed to preview.js and queue.js */
function makeDeps() {
  return { renderBooks, refreshSummary, enqueueAndStart: enqueueAndStartBound };
}

function enqueueAndStartBound(books, root) {
  enqueueAndStart(books, root, { refreshSummary, renderBooks });
}

function row(book, root) {
  const checked = STATE.selected.has(book.absPath);
  const cb = el("input", { type: "checkbox", class: "lib-cb" });
  if (checked) cb.checked = true;
  cb.addEventListener("change", () => {
    if (cb.checked) STATE.selected.set(book.absPath, book);
    else STATE.selected.delete(book.absPath);
    refreshSummary(root);
  });

  const isPreviewing = STATE.previewBook?.absPath === book.absPath;
  const node = el("div", { class: `lib-row${isPreviewing ? " lib-row-active" : ""}` }, [
    cb,
    extBadge(book.ext),
    el("div", { class: "lib-name", title: book.absPath }, book.fileName),
    el("div", { class: "lib-size" }, fmtMB(book.sizeBytes)),
    statusForBook(book),
  ]);
  node.addEventListener("click", (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    selectForPreview(book, root, makeDeps());
  });
  return node;
}

function groupKeyForBook(book, mode) {
  if (mode === "ext") return String(book.ext || "?").toLowerCase();
  if (mode === "status") return statusKeyForBook(book);
  if (mode === "folder") {
    const sep = book.absPath.includes("\\") ? "\\" : "/";
    const parts = book.absPath.split(sep);
    return parts.slice(0, -1).pop() || "(root)";
  }
  return "all";
}

function groupedBooks(mode) {
  /** @type {Map<string, import("./state.js").BookFile[]>} */
  const map = new Map();
  for (const b of STATE.books) {
    const key = groupKeyForBook(b, mode);
    const arr = map.get(key) ?? [];
    arr.push(b);
    map.set(key, arr);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

export function renderBooks(listEl, root) {
  if (!listEl) return;
  clear(listEl);
  if (STATE.books.length === 0) {
    listEl.appendChild(el("div", { class: "lib-empty" }, t("library.empty")));
    return;
  }
  const mode = STATE.prefs.groupBy;
  if (mode === "none") {
    for (const b of STATE.books) listEl.appendChild(row(b, root));
    return;
  }
  for (const [key, books] of groupedBooks(mode)) {
    const head = el("div", { class: "lib-group-head" }, [
      el("span", { class: "lib-group-key" }, t(`library.group.label.${mode}`) + ": " + key),
      el("span", { class: "lib-group-count" }, `${books.length}`),
      el("button", {
        class: "lib-group-select",
        type: "button",
        onclick: () => {
          for (const b of books) STATE.selected.set(b.absPath, b);
          renderBooks(listEl, root);
          refreshSummary(root);
        },
      }, t("library.group.selectAll")),
    ]);
    const body = el("div", { class: "lib-group-body" });
    for (const b of books) body.appendChild(row(b, root));
    listEl.appendChild(el("div", { class: "lib-group" }, [head, body]));
  }
}

async function loadCollections() {
  try {
    /** @type {string[]} */
    const cols = await window.api.getCollections();
    STATE.collections = cols;
    if (!STATE.collection || !cols.includes(STATE.collection)) {
      STATE.collection = cols[0] || "library";
    }
  } catch (_e) {
    console.warn("[library] loadCollections failed:", _e);
    STATE.collections = [];
  }
}

async function loadPrefs() {
  try {
    const prefs = await window.api.preferences.getAll();
    STATE.prefs.queueParallelism = Number(prefs.ingestParallelism) || 3;
    STATE.prefs.ocrEnabled = Boolean(prefs.ocrEnabled);
    STATE.prefs.groupBy = String(prefs.libraryGroupBy || "none");
  } catch (_e) { console.warn("[library] loadPrefs failed:", _e); }
  try {
    const support = await window.api.scanner.ocrSupport();
    STATE.prefs.ocrSupported = Boolean(support?.supported);
    STATE.prefs.ocrPlatform = String(support?.platform || "unknown");
    STATE.prefs.ocrReason = String(support?.reason || "");
  } catch (_e) { console.warn("[library] ocrSupport check failed:", _e); }
}

async function probeFolder(root, listEl) {
  if (STATE.busy) return;
  STATE.busy = true;
  try {
    const files = await window.api.scanner.probeFolder();
    mergeFiles(files);
    refreshSummary(root);
    renderBooks(listEl, root);
  } finally {
    STATE.busy = false;
  }
}

async function openFiles(root, listEl) {
  if (STATE.busy) return;
  STATE.busy = true;
  try {
    const files = await window.api.scanner.openFiles();
    mergeFiles(files);
    refreshSummary(root);
    renderBooks(listEl, root);
  } finally {
    STATE.busy = false;
  }
}

export async function ingestDroppedPaths(paths, root, listEl) {
  if (!paths.length) return;
  STATE.busy = true;
  try {
    const files = await window.api.scanner.probeFiles(paths);
    if (files.length === 0) return;
    mergeFiles(files);
    refreshSummary(root);
    renderBooks(listEl, root);
  } finally {
    STATE.busy = false;
  }
}

function mergeFiles(files) {
  const seen = new Set(STATE.books.map((b) => b.absPath));
  for (const f of files) {
    if (!seen.has(f.absPath)) {
      STATE.books.push(f);
      seen.add(f.absPath);
    }
  }
  STATE.books.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function buildDropzone(root, listEl) {
  const dz = el("div", {
    class: "lib-dropzone",
    role: "button",
    tabindex: "0",
    "aria-label": t("library.dropzone.aria"),
  }, [
    el("div", { class: "lib-dropzone-icon", "aria-hidden": "true" }, "+"),
    el("div", { class: "lib-dropzone-title" }, t("library.dropzone.title")),
    el("div", { class: "lib-dropzone-hint" }, t("library.dropzone.hint")),
  ]);

  const stop = (ev) => { ev.preventDefault(); ev.stopPropagation(); };

  ["dragenter", "dragover"].forEach((evName) => {
    dz.addEventListener(evName, (ev) => { stop(ev); dz.classList.add("lib-dropzone-active"); });
  });
  ["dragleave", "drop"].forEach((evName) => {
    dz.addEventListener(evName, (ev) => { stop(ev); dz.classList.remove("lib-dropzone-active"); });
  });

  dz.addEventListener("drop", async (ev) => {
    const paths = collectDroppedPaths(ev);
    if (paths.length > 0) await ingestDroppedPaths(paths, root, listEl);
  });

  dz.addEventListener("click", async () => {
    await openFiles(root, listEl);
  });

  return dz;
}

function collectDroppedPaths(ev) {
  const files = ev.dataTransfer?.files;
  if (!files) return [];
  /** @type {string[]} */
  const paths = [];
  for (let i = 0; i < files.length; i++) {
    if (files[i].path) paths.push(files[i].path);
  }
  return paths;
}

export function buildGroupControl(root, listEl) {
  const select = el("select", { class: "lib-group-select-box" }, [
    el("option", { value: "none" }, t("library.group.none")),
    el("option", { value: "ext" }, t("library.group.ext")),
    el("option", { value: "status" }, t("library.group.status")),
    el("option", { value: "folder" }, t("library.group.folder")),
  ]);
  select.value = STATE.prefs.groupBy;
  select.addEventListener("change", () => {
    STATE.prefs.groupBy = /** @type {import("./state.js").GroupMode} */ (select.value);
    renderBooks(listEl, root);
    try { window.api.preferences.set({ libraryGroupBy: select.value }); } catch (_e) { /* tolerate: pref save non-critical */ }
  });
  return el("label", { class: "lib-group-label" }, [t("library.group.label.control") + " ", select]);
}

export function buildCollectionInput() {
  const wrap = el("div", { class: "lib-collection-wrap" });
  const label = el("label", { class: "lib-collection-label" }, t("library.collection.label"));
  const input = el("input", {
    type: "text", class: "lib-collection-input",
    placeholder: "library", list: "lib-collection-suggestions",
  });
  input.value = STATE.collection || "library";
  input.addEventListener("input", () => {
    STATE.collection = input.value.trim();
  });
  const datalist = el("datalist", { id: "lib-collection-suggestions" });
  wrap.append(label, input, datalist);
  return { wrap, input, datalist };
}

export function buildLibrarySummary() {
  return el("div", { class: "lib-summary" }, [
    t("library.summary.selected") + " ",
    el("strong", { id: "lib-selected-count" }, "0"),
    " / ",
    el("strong", { id: "lib-total-count" }, "0"),
    " - ",
    t("library.summary.queue") + " ",
    el("strong", { id: "lib-queue-count" }, "0"),
  ]);
}

export function buildOcrBadge() {
  return STATE.prefs.ocrSupported
    ? el("span", { class: "lib-ocr-badge lib-ocr-badge-ok", title: t("library.ocr.badge.ok.tooltip") },
        t("library.ocr.badge.ok").replace("{platform}", STATE.prefs.ocrPlatform))
    : el("span", { class: "lib-ocr-badge lib-ocr-badge-off", title: STATE.prefs.ocrReason || t("library.ocr.badge.off.tooltip") },
        t("library.ocr.badge.off"));
}

/**
 * @param {HTMLElement} root
 * @param {HTMLElement} listEl
 */
export function buildLibraryActionButtons(root, listEl) {
  const btnPick = /** @type {HTMLButtonElement} */ (el("button", { class: "lib-btn lib-btn-primary", type: "button" }, t("library.btn.pickFolder")));
  const btnOpenFiles = /** @type {HTMLButtonElement} */ (el("button", { class: "lib-btn", type: "button" }, t("library.btn.openFiles")));
  const btnStart = /** @type {HTMLButtonElement} */ (el("button", { class: "lib-btn lib-btn-accent", type: "button", disabled: "true" }, t("library.btn.ingest")));
  const btnCancel = /** @type {HTMLButtonElement} */ (el("button", { class: "lib-btn", type: "button" }, t("library.btn.cancelAll")));

  btnPick.addEventListener("click", async () => {
    btnPick.disabled = true;
    try {
      await loadHistory();
      await probeFolder(root, listEl);
      btnStart.disabled = STATE.books.length === 0;
    } finally {
      btnPick.disabled = false;
    }
  });
  btnOpenFiles.addEventListener("click", async () => {
    btnOpenFiles.disabled = true;
    try {
      await loadHistory();
      await openFiles(root, listEl);
      btnStart.disabled = STATE.books.length === 0;
    } finally {
      btnOpenFiles.disabled = false;
    }
  });
  btnStart.addEventListener("click", () => {
    const books = Array.from(STATE.selected.values());
    enqueueAndStartBound(books, root);
  });
  btnCancel.addEventListener("click", () => { cancelAll(root, { refreshSummary }); });

  return { btnPick, btnOpenFiles, btnStart, btnCancel };
}
