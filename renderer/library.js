// @ts-check
/**
 * Library page (Phase 6.0+).
 *
 * Adds drag&drop ingestion, multi-file open dialog, grouping (none/ext/status/folder)
 * and an OCR per-task override on top of the existing browse / search / history flow.
 *
 * Hardcoded constants (parallelism, OCR defaults) are sourced from preferences
 * at mount-time so settings changes propagate next visit.
 */
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildCollectionPicker } from "./components/collection-picker.js";

/** @typedef {{ absPath: string, fileName: string, ext: string, sizeBytes: number, mtimeMs: number }} BookFile */
/** @typedef {{ ingestId: string, phase: string, bookSourcePath: string, bookTitle: string, totalChunks: number, processedChunks: number, embeddedChunks: number, upsertedChunks: number, message?: string, errorMessage?: string }} ProgressEvent */
/** @typedef {{ collection: string, books: Array<{ bookSourcePath: string, fileName: string, status: "running"|"done"|"error"|"paused", totalChunks: number, processedChunks: number, startedAt: string, lastUpdatedAt: string, errorMessage?: string }>, totalBooks: number, totalChunks: number }} HistoryGroup */
/** @typedef {"none"|"ext"|"status"|"folder"} GroupMode */

const STATE = {
  /** @type {"catalog"|"import"|"browse"|"history"|"search"} */
  tab: "catalog",
  /** Selected target Qdrant collection (used both for legacy browse-ingest and Iter 6 batch crystallization). */
  targetCollection: "",
  /** @type {BookFile[]} */
  books: [],
  /** @type {Map<string, BookFile>} */
  selected: new Map(),
  /** @type {Map<string, ProgressEvent>} */
  progress: new Map(),
  /** @type {Set<string>} */
  knownPaths: new Set(),
  /** @type {string} */
  collection: "",
  /** @type {string[]} */
  collections: [],
  /** @type {Map<string, string>} */
  activeIngests: new Map(),
  /** @type {BookFile[]} */
  queue: [],
  /** @type {BookFile | null} */
  previewBook: null,
  /** @type {"idle"|"loading"|"ready"|"error"} */
  previewState: "idle",
  previewData: null,
  /** @type {HistoryGroup[]} */
  history: [],
  busy: false,
  paused: false,
  /** Runtime preferences -- loaded from preferences store on mount. */
  prefs: {
    queueParallelism: 3,
    ocrEnabled: false,
    ocrSupported: false,
    ocrPlatform: "unknown",
    ocrReason: "",
    /** @type {GroupMode} */
    groupBy: "none",
  },
  /** Per-mount UI overrides (applied to startIngest). */
  ocrOverride: /** @type {boolean | null} */ (null),
};

let unsubscribeProgress = null;

function fmtMB(bytes) {
  if (!bytes) return "--";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

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

function refreshSummary(root) {
  const sel = root.querySelector("#lib-selected-count");
  if (sel) sel.textContent = String(STATE.selected.size);
  const total = root.querySelector("#lib-total-count");
  if (total) total.textContent = String(STATE.books.length);
  const queueLen = root.querySelector("#lib-queue-count");
  if (queueLen) queueLen.textContent = String(STATE.queue.length + STATE.activeIngests.size);
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
    selectForPreview(book, root);
  });
  return node;
}

/* ───── grouping ───── */

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
  /** @type {Map<string, BookFile[]>} */
  const map = new Map();
  for (const b of STATE.books) {
    const key = groupKeyForBook(b, mode);
    const arr = map.get(key) ?? [];
    arr.push(b);
    map.set(key, arr);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function renderBooks(listEl, root) {
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

/* ───── preview ───── */

async function selectForPreview(book, root) {
  STATE.previewBook = book;
  STATE.previewState = "loading";
  STATE.previewData = null;
  renderPreview(root);
  renderBooks(root.querySelector(".lib-list"), root);
  try {
    const data = await window.api.scanner.parsePreview(book.absPath);
    if (STATE.previewBook?.absPath !== book.absPath) return;
    STATE.previewData = data;
    STATE.previewState = "ready";
  } catch (e) {
    if (STATE.previewBook?.absPath !== book.absPath) return;
    STATE.previewData = { error: e instanceof Error ? e.message : String(e) };
    STATE.previewState = "error";
  }
  renderPreview(root);
}

function renderPreview(root) {
  const pane = root.querySelector(".lib-preview");
  if (!pane) return;
  clear(pane);
  if (!STATE.previewBook) {
    pane.appendChild(el("div", { class: "lib-preview-empty" }, t("library.preview.empty")));
    return;
  }
  const header = el("div", { class: "lib-preview-header" }, [
    el("div", { class: "lib-preview-title" }, STATE.previewBook.fileName),
    el("button", { class: "lib-preview-close", type: "button", "aria-label": "close",
      onclick: () => { STATE.previewBook = null; renderPreview(root); renderBooks(root.querySelector(".lib-list"), root); } }, "x"),
  ]);
  pane.appendChild(header);
  if (STATE.previewState === "loading") {
    pane.appendChild(el("div", { class: "lib-preview-loading" }, t("library.preview.loading")));
    return;
  }
  if (STATE.previewState === "error" || !STATE.previewData) {
    const msg = STATE.previewData?.error || "--";
    pane.appendChild(el("div", { class: "lib-preview-error" }, [t("library.preview.error") + ": ", msg]));
    return;
  }
  if (STATE.previewState !== "ready") return;
  const d = STATE.previewData;
  const meta = d.metadata ?? {};
  const stats = el("div", { class: "lib-preview-stats" }, [
    el("div", {}, [el("strong", {}, t("library.preview.stat.title") + ": "), meta.title ?? "--"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.author") + ": "), meta.author ?? "--"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.lang") + ": "), meta.language ?? "--"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.sections") + ": "), String(d.sectionCount)]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.estChunks") + ": "), String(d.estimatedChunks)]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.chars") + ": "), String(d.rawCharCount)]),
  ]);
  pane.appendChild(stats);
  if (Array.isArray(meta.warnings) && meta.warnings.length > 0) {
    const w = el("div", { class: "lib-preview-warnings" }, [
      el("strong", {}, t("library.preview.warnings") + ":"),
      ...meta.warnings.map((wm) => el("div", { class: "lib-warning" }, "* " + wm)),
    ]);
    pane.appendChild(w);

    const hasOcrCandidate = meta.warnings.some((wm) => /scanned|image|OCR|no text/i.test(String(wm)));
    if (hasOcrCandidate && d.rawCharCount === 0) {
      pane.appendChild(buildOcrHintCard());
    }
  }
  const samples = el("div", { class: "lib-preview-samples" }, [
    el("strong", {}, t("library.preview.firstChunks") + ":"),
  ]);
  for (const c of d.sampleChunks ?? []) {
    samples.appendChild(
      el("div", { class: "lib-sample" }, [
        el("div", { class: "lib-sample-head" }, `${c.chapterTitle} - #${c.chunkIndex} - ${c.charCount} chars`),
        el("div", { class: "lib-sample-body" }, c.text),
      ])
    );
  }
  pane.appendChild(samples);

  const ocrToggleWrap = STATE.prefs.ocrSupported ? buildOcrToggle(root) : null;

  const actions = el("div", { class: "lib-preview-actions" }, [
    el("button", { class: "lib-btn lib-btn-accent", type: "button",
      onclick: () => {
        STATE.selected.set(STATE.previewBook.absPath, STATE.previewBook);
        enqueueAndStart([STATE.previewBook], root);
      } }, t("library.preview.btn.ingestThis")),
    ocrToggleWrap,
  ].filter(Boolean));
  pane.appendChild(actions);
}

function buildOcrHintCard() {
  if (STATE.prefs.ocrSupported) {
    return el("div", { class: "lib-warning-ocr lib-warning-ocr-actionable", role: "note" }, [
      el("span", { class: "lib-warning-ocr-icon", "aria-hidden": "true" }, "i"),
      el("div", {}, [
        el("span", { class: "lib-warning-ocr-title" }, t("library.preview.ocr.actionable.title")),
        el("span", { class: "lib-warning-ocr-body" }, t("library.preview.ocr.actionable.body")),
      ]),
    ]);
  }
  return el("div", { class: "lib-warning-ocr", role: "note" }, [
    el("span", { class: "lib-warning-ocr-icon", "aria-hidden": "true" }, "i"),
    el("div", {}, [
      el("span", { class: "lib-warning-ocr-title" }, t("library.preview.ocr.title")),
      el("span", { class: "lib-warning-ocr-body" }, t("library.preview.ocr.body")),
    ]),
  ]);
}

function buildOcrToggle(root) {
  const checked = STATE.ocrOverride !== null ? STATE.ocrOverride : STATE.prefs.ocrEnabled;
  const cb = el("input", { type: "checkbox", class: "lib-ocr-cb", id: "lib-ocr-toggle" });
  if (checked) cb.checked = true;
  cb.addEventListener("change", () => {
    STATE.ocrOverride = cb.checked;
    renderPreview(root);
  });
  return el("label", { class: "lib-ocr-toggle", for: "lib-ocr-toggle", title: t("library.ocr.tooltip") }, [
    cb,
    el("span", {}, t("library.ocr.label")),
  ]);
}

/* ───── data loaders ───── */

async function loadCollections() {
  try {
    /** @type {string[]} */
    const cols = await window.api.getCollections();
    STATE.collections = cols;
    if (!STATE.collection || !cols.includes(STATE.collection)) {
      STATE.collection = cols[0] || "library";
    }
  } catch {
    STATE.collections = [];
  }
}

async function loadHistory() {
  try {
    STATE.history = await window.api.scanner.listHistory();
    STATE.knownPaths.clear();
    for (const g of STATE.history) for (const b of g.books) STATE.knownPaths.add(b.bookSourcePath);
  } catch {
    STATE.history = [];
  }
}

async function loadPrefs() {
  try {
    const prefs = await window.api.preferences.getAll();
    STATE.prefs.queueParallelism = Number(prefs.ingestParallelism) || 3;
    STATE.prefs.ocrEnabled = Boolean(prefs.ocrEnabled);
    STATE.prefs.groupBy = String(prefs.libraryGroupBy || "none");
  } catch { /* defaults already set */ }
  try {
    const support = await window.api.scanner.ocrSupport();
    STATE.prefs.ocrSupported = Boolean(support?.supported);
    STATE.prefs.ocrPlatform = String(support?.platform || "unknown");
    STATE.prefs.ocrReason = String(support?.reason || "");
  } catch { /* leave defaults */ }
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

async function ingestDroppedPaths(paths, root, listEl) {
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

/** Append-only merge that preserves existing selection and never duplicates. */
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

/* ───── queue runner ───── */

function enqueueAndStart(books, root) {
  for (const b of books) {
    if (STATE.queue.find((x) => x.absPath === b.absPath)) continue;
    if (STATE.activeIngests.has(b.absPath)) continue;
    STATE.queue.push(b);
  }
  refreshSummary(root);
  pumpQueue(root);
}

async function pumpQueue(root) {
  if (STATE.paused) return;
  while (STATE.activeIngests.size < STATE.prefs.queueParallelism && STATE.queue.length > 0) {
    const next = STATE.queue.shift();
    if (!next) break;
    if (!STATE.collection) {
      alert(t("library.alert.collection"));
      STATE.queue.unshift(next);
      return;
    }
    runOne(next, root);
  }
  refreshSummary(root);
}

async function runOne(book, root) {
  STATE.activeIngests.set(book.absPath, "pending");
  if (STATE.tab === "history") renderHistory(root);
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
    renderBooks(root.querySelector(".lib-list"), root);
    refreshSummary(root);
    pumpQueue(root);
    if (STATE.tab === "history") renderHistory(root);
    if (STATE.activeIngests.size === 0 && STATE.queue.length === 0) {
      loadHistory().then(() => {
        if (STATE.tab === "history") renderHistory(root);
      });
    }
  }
}

async function cancelAll(root) {
  STATE.paused = true;
  STATE.queue.length = 0;
  for (const [, id] of STATE.activeIngests) {
    if (id && id !== "pending") {
      try { await window.api.scanner.cancelIngest(id); } catch { /* ignore */ }
    }
  }
  STATE.activeIngests.clear();
  refreshSummary(root);
  STATE.paused = false;
}

/* ───── history tab ───── */

function renderHistory(root) {
  const wrap = root.querySelector(".lib-history");
  if (!wrap) return;
  clear(wrap);
  if (STATE.history.length === 0) {
    wrap.appendChild(el("div", { class: "lib-empty" }, t("library.history.empty")));
    return;
  }
  for (const group of STATE.history) {
    const head = el("div", { class: "lib-hist-group-head" }, [
      el("strong", { class: "lib-hist-collection" }, group.collection),
      el("span", { class: "lib-hist-meta" }, ` - ${group.totalBooks} ${t("library.history.books")} - ${group.totalChunks} ${t("library.history.chunks")}`),
    ]);
    const list = el("div", { class: "lib-hist-list" });
    for (const b of group.books) {
      const isIngesting = STATE.activeIngests.has(b.bookSourcePath);
      const delBtnAttrs = isIngesting
        ? { class: "lib-btn lib-btn-small", type: "button", disabled: "true", title: t("library.history.btn.deleteDisabled") }
        : {
            class: "lib-btn lib-btn-small",
            type: "button",
            onclick: async () => {
              if (STATE.activeIngests.has(b.bookSourcePath)) {
                alert(t("library.history.deleteWhileIngest"));
                return;
              }
              if (!confirm(t("library.history.confirmDelete").replace("{book}", b.fileName).replace("{collection}", group.collection))) return;
              try {
                await window.api.scanner.deleteFromCollection(b.bookSourcePath, group.collection);
                await loadHistory();
                renderHistory(root);
              } catch (e) {
                alert(t("library.history.deleteFailed") + ": " + (e instanceof Error ? e.message : String(e)));
              }
            },
          };
      list.appendChild(
        el("div", { class: "lib-hist-row" }, [
          el("span", { class: `lib-hist-status lib-hist-status-${b.status}` }, b.status),
          el("div", { class: "lib-hist-name", title: b.bookSourcePath }, b.fileName),
          el("div", { class: "lib-hist-counts" }, `${b.processedChunks}/${b.totalChunks}`),
          el("div", { class: "lib-hist-date" }, fmtDate(b.lastUpdatedAt)),
          el("button", delBtnAttrs, t("library.history.btn.delete")),
        ])
      );
    }
    wrap.appendChild(el("div", { class: "lib-hist-group" }, [head, list]));
  }
}

/* ───── search tab (BookHunter) ───── */

/**
 * @typedef {{ downloadId: string, downloaded: number, total: number | null, status: "downloading"|"ingesting"|"done"|"error"|"cancelled", message?: string }} DownloadState
 */

/** @type {{ query: string, results: Array<any>, searching: boolean, error: string }} */
const SEARCH_STATE = { query: "", results: [], searching: false, error: "" };

/** Active downloads: candidate.id -> DownloadState. */
/** @type {Map<string, DownloadState>} */
const DOWNLOAD_STATE = new Map();
/** Reverse map: downloadId -> candidate.id (so progress events can find the card). */
/** @type {Map<string, string>} */
const DOWNLOAD_BY_ID = new Map();
let unsubscribeDownloadProgress = null;

function renderSearch(root) {
  const wrap = root.querySelector(".lib-search");
  if (!wrap) return;
  clear(wrap);

  const bar = el("div", { class: "lib-search-bar" }, [
    el("input", {
      type: "text", class: "lib-search-input",
      placeholder: t("library.search.placeholder"),
      value: SEARCH_STATE.query, id: "lib-search-q",
    }),
    el("button", {
      class: "lib-btn lib-btn-primary", type: "button",
      disabled: SEARCH_STATE.searching ? "true" : undefined,
      onclick: () => doSearch(root),
    }, SEARCH_STATE.searching ? "..." : t("library.search.btn")),
  ]);
  wrap.appendChild(bar);

  const qInput = wrap.querySelector("#lib-search-q");
  if (qInput) {
    qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(root); });
    qInput.addEventListener("input", (e) => { SEARCH_STATE.query = e.target.value; });
  }

  if (SEARCH_STATE.error) {
    wrap.appendChild(el("div", { class: "lib-search-error", role: "alert" }, [
      el("strong", {}, t("library.search.error") + ": "),
      SEARCH_STATE.error,
    ]));
  }

  if (SEARCH_STATE.results.length === 0 && !SEARCH_STATE.searching && !SEARCH_STATE.error) {
    wrap.appendChild(el("div", { class: "lib-search-hint" }, t("library.search.hint")));
    return;
  }

  const list = el("div", { class: "lib-search-results" });
  for (const r of SEARCH_STATE.results) {
    list.appendChild(buildSearchCard(r, root));
  }
  wrap.appendChild(list);
}

function buildSearchCard(candidate, root) {
  const fmts = (candidate.formats || []).map((f) => f.format || f).join(", ");
  const dlState = DOWNLOAD_STATE.get(candidate.id);

  const actionsWrap = el("div", { class: "lib-search-actions" });
  const card = el("div", { class: "lib-search-card", "data-candidate-id": candidate.id }, [
    el("div", { class: "lib-search-title" }, candidate.title),
    el("div", { class: "lib-search-meta" }, [
      candidate.authors?.join(", ") || "--",
      candidate.year ? ` - ${candidate.year}` : "",
      ` - ${candidate.sourceTag}`,
      ` - ${candidate.license}`,
      fmts ? ` - ${fmts}` : "",
    ].join("")),
    candidate.description ? el("div", { class: "lib-search-desc" }, candidate.description.slice(0, 200)) : null,
    actionsWrap,
  ]);

  refreshSearchCardActions(card, candidate, root, dlState);
  return card;
}

function refreshSearchCardActions(card, candidate, root, dlState) {
  const actionsWrap = card.querySelector(".lib-search-actions");
  if (!actionsWrap) return;
  clear(actionsWrap);

  if (dlState && (dlState.status === "downloading" || dlState.status === "ingesting")) {
    const pct = dlState.total ? Math.min(100, Math.floor((dlState.downloaded / dlState.total) * 100)) : null;
    const label = dlState.status === "ingesting"
      ? t("library.search.status.ingesting")
      : pct !== null
        ? `${pct}% (${formatBytes(dlState.downloaded)}/${formatBytes(dlState.total)})`
        : `${formatBytes(dlState.downloaded)}`;
    actionsWrap.appendChild(
      el("div", { class: "lib-search-progress", role: "status", "aria-live": "polite" }, [
        el("div", { class: "lib-search-progress-bar" }, [
          el("div", { class: "lib-search-progress-fill", style: `width: ${pct ?? 50}%` }),
        ]),
        el("div", { class: "lib-search-progress-label" }, label),
      ])
    );
    actionsWrap.appendChild(
      el("button", {
        class: "lib-btn lib-btn-small", type: "button",
        onclick: async () => {
          try {
            await window.api.bookhunter.cancelDownload(dlState.downloadId);
            updateDownloadStatus(candidate.id, "cancelled", t("library.search.status.cancelled"), root);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            updateDownloadStatus(candidate.id, "error", t("library.search.cancelFailed") + ": " + msg, root);
          }
        },
      }, t("library.search.btn.cancel"))
    );
    return;
  }

  if (dlState?.status === "done") {
    actionsWrap.appendChild(el("button", {
      class: "lib-btn lib-btn-accent lib-btn-small", type: "button", disabled: "true",
    }, dlState.message || t("library.search.status.done")));
  } else if (dlState?.status === "error" || dlState?.status === "cancelled") {
    actionsWrap.appendChild(el("div", { class: "lib-search-error-inline" }, dlState.message || dlState.status));
    actionsWrap.appendChild(el("button", {
      class: "lib-btn lib-btn-accent lib-btn-small", type: "button",
      onclick: () => startCardDownload(candidate, root),
    }, t("library.search.btn.retry")));
  } else {
    actionsWrap.appendChild(el("button", {
      class: "lib-btn lib-btn-accent lib-btn-small", type: "button",
      onclick: () => startCardDownload(candidate, root),
    }, t("library.search.btn.downloadIngest")));
  }

  if (candidate.webPageUrl) {
    actionsWrap.appendChild(el("a", {
      class: "lib-search-link", href: candidate.webPageUrl,
      target: "_blank", rel: "noopener",
    }, t("library.search.btn.openPage")));
  }
}

async function startCardDownload(candidate, root) {
  if (!STATE.collection) { alert(t("library.alert.collection")); return; }
  const cur = DOWNLOAD_STATE.get(candidate.id);
  /* Block while still active (downloading OR ingesting). Allow restart
     from terminal states (done / error / cancelled) -- e.g. retry, or
     re-download into a different collection. */
  if (cur && (cur.status === "downloading" || cur.status === "ingesting")) return;
  const downloadId = makeDownloadId();
  const initial = { downloadId, downloaded: 0, total: null, status: "downloading" };
  DOWNLOAD_STATE.set(candidate.id, initial);
  DOWNLOAD_BY_ID.set(downloadId, candidate.id);
  rerenderCard(candidate.id, root);
  try {
    const res = await window.api.bookhunter.downloadAndIngest({
      candidate, collection: STATE.collection, downloadId,
    });
    DOWNLOAD_STATE.set(candidate.id, {
      downloadId, downloaded: 0, total: 0,
      status: "done",
      message: t("library.search.status.doneCount").replace("{count}", String(res.upserted)),
    });
    loadHistory();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cancelled = /aborted|user-cancel/i.test(msg);
    DOWNLOAD_STATE.set(candidate.id, {
      downloadId, downloaded: 0, total: 0,
      status: cancelled ? "cancelled" : "error",
      message: cancelled ? t("library.search.status.cancelled") : msg,
    });
  } finally {
    DOWNLOAD_BY_ID.delete(downloadId);
    rerenderCard(candidate.id, root);
  }
}

function updateDownloadStatus(candidateId, status, message, root) {
  const cur = DOWNLOAD_STATE.get(candidateId);
  if (!cur) return;
  DOWNLOAD_STATE.set(candidateId, { ...cur, status, message });
  rerenderCard(candidateId, root);
}

function rerenderCard(candidateId, root) {
  const card = root.querySelector(`.lib-search-card[data-candidate-id="${cssEscape(candidateId)}"]`);
  if (!card) return;
  const candidate = SEARCH_STATE.results.find((r) => r.id === candidateId);
  if (!candidate) return;
  refreshSearchCardActions(card, candidate, root, DOWNLOAD_STATE.get(candidateId));
}

function cssEscape(str) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(str);
  return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function makeDownloadId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "dl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function doSearch(root) {
  const q = SEARCH_STATE.query.trim();
  if (!q || SEARCH_STATE.searching) return;
  SEARCH_STATE.searching = true;
  SEARCH_STATE.results = [];
  SEARCH_STATE.error = "";
  renderSearch(root);
  try {
    SEARCH_STATE.results = await window.api.bookhunter.search({ query: q, perSourceLimit: 6 });
  } catch (e) {
    SEARCH_STATE.error = e instanceof Error ? e.message : String(e);
  } finally {
    SEARCH_STATE.searching = false;
    renderSearch(root);
  }
}

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

/* ───── dropzone ───── */

function buildDropzone(root, listEl) {
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

  dz.addEventListener("drop", (ev) => {
    const dt = ev.dataTransfer;
    if (!dt) return;
    const paths = collectDroppedPaths(dt);
    if (paths.length === 0) {
      alert(t("library.dropzone.unsupported"));
      return;
    }
    ingestDroppedPaths(paths, root, listEl);
  });

  dz.addEventListener("click", () => { openFiles(root, listEl); });
  dz.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      openFiles(root, listEl);
    }
  });
  return dz;
}

function collectDroppedPaths(dt) {
  /** @type {string[]} */
  const out = [];
  if (dt.files && dt.files.length > 0) {
    for (const f of dt.files) {
      const p = /** @type {{ path?: string }} */ (f).path;
      if (typeof p === "string" && p.length > 0) out.push(p);
    }
  }
  return out;
}

/* ───── group control ───── */

function buildGroupControl(root, listEl) {
  const select = el("select", { class: "lib-group-select-mode", id: "lib-group-mode" });
  for (const opt of /** @type {GroupMode[]} */ (["none", "ext", "status", "folder"])) {
    const o = el("option", { value: opt }, t("library.group.mode." + opt));
    if (STATE.prefs.groupBy === opt) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", async () => {
    STATE.prefs.groupBy = /** @type {GroupMode} */ (select.value);
    renderBooks(listEl, root);
    try { await window.api.preferences.set({ libraryGroupBy: STATE.prefs.groupBy }); } catch { /* persist best-effort */ }
  });
  return el("label", { class: "lib-group-wrap" }, [
    el("span", {}, t("library.group.title")),
    select,
  ]);
}

/* ───── mount ───── */

function buildLibraryTabs(root) {
  return el("div", { class: "lib-tabs" }, [
    el("button", { class: "lib-tab lib-tab-active", type: "button", "data-tab": "catalog",
      onclick: () => switchTab("catalog", root) }, t("library.tab.catalog")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "import",
      onclick: () => switchTab("import", root) }, t("library.tab.import")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "search",
      onclick: () => switchTab("search", root) }, t("library.tab.hunt")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "browse",
      onclick: () => switchTab("browse", root) }, t("library.tab.ingest")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "history",
      onclick: () => switchTab("history", root) }, t("library.tab.history")),
  ]);
}

/* ═══════════════════ CATALOG (Iter 5b) ═══════════════════ */

/**
 * @typedef {object} CatalogMeta
 * @property {string} id
 * @property {string} title
 * @property {string} [titleEn]
 * @property {string} [author]
 * @property {string} [authorEn]
 * @property {string} [domain]
 * @property {number} wordCount
 * @property {number} [qualityScore]
 * @property {boolean} [isFictionOrWater]
 * @property {string} status
 * @property {string[]} [tags]
 */

const CATALOG = {
  /** @type {CatalogMeta[]} */
  rows: [],
  total: 0,
  /** @type {Set<string>} bookId */
  selected: new Set(),
  filters: {
    /** Quality score floor (0..100). 0 = no filter. */
    quality: 0,
    /** Hide books flagged is_fiction_or_water. */
    hideFiction: false,
    /** Free-text filter against title/author/tags. */
    search: "",
  },
  loading: false,
  /** Subscriptions are owned by mountLibrary; we just store the unsub fns here. */
  unsubEvaluator: /** @type {null | (() => void)} */ (null),
  unsubBatch: /** @type {null | (() => void)} */ (null),
};

/**
 * Multi-book crystallization batch state. Tracks live progress so the
 * Catalog UI (button label, summary, per-row status) reflects the
 * background extraction without a roundtrip to disk.
 *
 * Lifecycle: idle → starting → running (per-book transitions) → done|cancelled|failed → idle.
 *
 * `lastJobId` is harvested from per-book child events (`parse.start` etc.
 * carry the inner runExtraction jobId) -- we use it to call
 * `datasetV2.cancel(jobId)` since the batch IPC doesn't expose its own
 * cancel handle (one runExtraction at a time, sequentially).
 */
const BATCH = {
  active: false,
  batchId: /** @type {string|null} */ (null),
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  /** @type {string|null} */
  currentBookId: null,
  /** @type {string|null} */
  currentBookTitle: null,
  /** @type {string|null} */
  lastJobId: null,
  /** @type {string|null} */
  collection: null,
};

const QUALITY_PRESETS = [
  { key: "all",      value: 0  },
  { key: "workable", value: 50 },
  { key: "solid",    value: 70 },
  { key: "premium",  value: 86 },
];

/** Pure: applies UI filters to fetched rows. */
function filterCatalog(rows) {
  const q = CATALOG.filters.quality;
  const hide = CATALOG.filters.hideFiction;
  const needle = CATALOG.filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (q > 0) {
      const score = typeof row.qualityScore === "number" ? row.qualityScore : -1;
      if (score < q) return false;
    }
    if (hide && row.isFictionOrWater === true) return false;
    if (needle) {
      const haystack = [
        row.titleEn, row.title, row.authorEn, row.author, row.domain,
        ...(row.tags ?? []),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function statusLabel(status) {
  const key = `library.catalog.status.${status}`;
  const trans = t(key);
  return trans === key ? status : trans;
}

function fmtWords(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function fmtQuality(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return String(Math.round(n));
}

function qualityClass(n) {
  if (typeof n !== "number") return "lib-q-unset";
  if (n >= 86) return "lib-q-premium";
  if (n >= 70) return "lib-q-solid";
  if (n >= 50) return "lib-q-workable";
  return "lib-q-low";
}

function statusClass(status) {
  return "lib-status-" + status.replace(/[^a-z0-9_-]/gi, "");
}

async function loadCatalog() {
  if (CATALOG.loading) return;
  CATALOG.loading = true;
  try {
    const res = await window.api.library.catalog({ limit: 5000 });
    CATALOG.rows = /** @type {CatalogMeta[]} */ (res.rows || []);
    CATALOG.total = res.total ?? CATALOG.rows.length;
  } catch (err) {
    console.error("[library.catalog] load failed:", err);
    CATALOG.rows = [];
    CATALOG.total = 0;
  } finally {
    CATALOG.loading = false;
  }
}

function renderCatalogTable(root) {
  const tbody = root.querySelector(".lib-catalog-tbody");
  if (!tbody) return;
  clear(tbody);

  const filtered = filterCatalog(CATALOG.rows);

  const shownEl = root.querySelector(".lib-catalog-summary-shown");
  if (shownEl) shownEl.textContent = t("library.catalog.summary.shown", {
    shown: String(filtered.length),
    total: String(CATALOG.total),
  });
  const selEl = root.querySelector(".lib-catalog-summary-selected");
  if (selEl) selEl.textContent = t("library.catalog.summary.selected", { n: String(CATALOG.selected.size) });

  if (CATALOG.rows.length === 0) {
    const emptyRow = el("tr", { class: "lib-catalog-empty-row" }, [
      el("td", { colspan: "7", class: "lib-empty-cell" }, [
        el("div", { class: "lib-empty-title" }, t("library.catalog.empty.title")),
        el("div", { class: "lib-empty-body" }, t("library.catalog.empty.body")),
      ]),
    ]);
    tbody.appendChild(emptyRow);
    return;
  }

  if (filtered.length === 0) {
    const emptyRow = el("tr", {}, [
      el("td", { colspan: "7", class: "lib-empty-cell" }, "—"),
    ]);
    tbody.appendChild(emptyRow);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of filtered) {
    const cb = /** @type {HTMLInputElement} */ (el("input", {
      type: "checkbox",
      class: "lib-catalog-cb",
      "data-book-id": row.id,
    }));
    cb.checked = CATALOG.selected.has(row.id);
    cb.addEventListener("change", () => {
      if (cb.checked) CATALOG.selected.add(row.id);
      else CATALOG.selected.delete(row.id);
      const sEl = root.querySelector(".lib-catalog-summary-selected");
      if (sEl) sEl.textContent = t("library.catalog.summary.selected", { n: String(CATALOG.selected.size) });
    });

    const titlePrimary = row.titleEn || row.title || "—";
    const titleSecondary = row.titleEn && row.title && row.titleEn !== row.title ? row.title : "";
    const authorPrimary = row.authorEn || row.author || "—";
    const fictionMark = row.isFictionOrWater ? " ◆" : "";

    const tr = el("tr", {
      class: "lib-catalog-row" + (row.isFictionOrWater ? " lib-catalog-row-fiction" : ""),
      "data-book-id": row.id,
    }, [
      el("td", { class: "lib-catalog-cell-cb" }, [cb]),
      el("td", { class: "lib-catalog-cell-title" }, [
        el("div", { class: "lib-catalog-title-en" }, titlePrimary + fictionMark),
        titleSecondary ? el("div", { class: "lib-catalog-title-orig" }, titleSecondary) : null,
      ].filter(Boolean)),
      el("td", { class: "lib-catalog-cell-author" }, authorPrimary),
      el("td", { class: "lib-catalog-cell-domain" }, row.domain || "—"),
      el("td", { class: "lib-catalog-cell-words" }, fmtWords(row.wordCount)),
      el("td", { class: `lib-catalog-cell-quality ${qualityClass(row.qualityScore)}` }, fmtQuality(row.qualityScore)),
      el("td", { class: `lib-catalog-cell-status ${statusClass(row.status)}` }, statusLabel(row.status)),
    ]);
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

async function renderCatalog(root) {
  const pane = root.querySelector(".lib-pane-catalog .lib-catalog-body");
  if (!pane) return;
  await loadCatalog();
  renderCatalogTable(root);
}

function buildCatalogToolbar(root) {
  const search = /** @type {HTMLInputElement} */ (el("input", {
    type: "search",
    class: "lib-catalog-search",
    placeholder: t("library.catalog.filter.search"),
    "aria-label": t("library.catalog.filter.search"),
  }));
  search.addEventListener("input", () => {
    CATALOG.filters.search = search.value;
    renderCatalogTable(root);
  });

  const slider = /** @type {HTMLInputElement} */ (el("input", {
    type: "range", min: "0", max: "100", step: "1", value: "0",
    class: "lib-catalog-quality-slider",
    "aria-label": t("library.catalog.filter.quality", { value: "0" }),
  }));
  const sliderLabel = el("span", { class: "lib-catalog-quality-label" },
    t("library.catalog.filter.quality", { value: "0" }));
  slider.addEventListener("input", () => {
    const v = parseInt(slider.value, 10) || 0;
    CATALOG.filters.quality = v;
    sliderLabel.textContent = t("library.catalog.filter.quality", { value: String(v) });
    syncPresetActive(root, v);
    renderCatalogTable(root);
  });

  const presets = el("div", { class: "lib-catalog-presets" }, QUALITY_PRESETS.map((p) =>
    el("button", {
      type: "button",
      class: "lib-catalog-preset" + (p.value === 0 ? " lib-catalog-preset-active" : ""),
      "data-preset": p.key,
      "data-value": String(p.value),
      onclick: () => {
        CATALOG.filters.quality = p.value;
        slider.value = String(p.value);
        sliderLabel.textContent = t("library.catalog.filter.quality", { value: String(p.value) });
        syncPresetActive(root, p.value);
        renderCatalogTable(root);
      },
    }, t(`library.catalog.filter.preset.${p.key}`))
  ));

  const fictionToggle = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    class: "lib-catalog-fiction-toggle",
    id: "lib-catalog-hide-fiction",
  }));
  fictionToggle.addEventListener("change", () => {
    CATALOG.filters.hideFiction = fictionToggle.checked;
    renderCatalogTable(root);
  });
  const fictionWrap = el("label", { class: "lib-catalog-fiction-wrap", for: "lib-catalog-hide-fiction" }, [
    fictionToggle, el("span", {}, t("library.catalog.filter.hideFiction")),
  ]);

  const refreshBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost",
    onclick: () => { void renderCatalog(root); },
  }, t("library.catalog.btn.refresh"));

  const rebuildBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost",
    title: t("library.catalog.btn.rebuild"),
    onclick: async () => {
      rebuildBtn.disabled = true;
      try {
        const r = await window.api.library.rebuildCache();
        await renderCatalog(root);
        const s = root.querySelector(".lib-catalog-summary-shown");
        if (s) s.textContent += `  ·  +${r.ingested} / -${r.pruned}`;
      } catch (e) {
        window.alert("Rebuild failed: " + (e instanceof Error ? e.message : String(e)));
      } finally {
        rebuildBtn.disabled = false;
      }
    },
  }, t("library.catalog.btn.rebuild"));

  return el("div", { class: "lib-catalog-toolbar" }, [
    el("div", { class: "lib-catalog-filter-row" }, [
      search,
      el("div", { class: "lib-catalog-quality-wrap" }, [sliderLabel, slider]),
      presets, fictionWrap,
    ]),
    el("div", { class: "lib-catalog-action-row" }, [refreshBtn, rebuildBtn]),
  ]);
}

function syncPresetActive(root, value) {
  root.querySelectorAll(".lib-catalog-preset").forEach((b) => {
    const v = parseInt(b.getAttribute("data-value") || "-1", 10);
    b.classList.toggle("lib-catalog-preset-active", v === value);
  });
}

function buildCatalogTable() {
  const headerCells = [
    { key: "checkbox", className: "lib-catalog-th lib-catalog-th-cb" },
    { key: "title",    className: "lib-catalog-th lib-catalog-th-title" },
    { key: "author",   className: "lib-catalog-th lib-catalog-th-author" },
    { key: "domain",   className: "lib-catalog-th lib-catalog-th-domain" },
    { key: "words",    className: "lib-catalog-th lib-catalog-th-words" },
    { key: "quality",  className: "lib-catalog-th lib-catalog-th-quality" },
    { key: "status",   className: "lib-catalog-th lib-catalog-th-status" },
  ];
  const thead = el("thead", {}, [
    el("tr", {}, headerCells.map((c) =>
      el("th", { class: c.className }, t(`library.catalog.col.${c.key}`))
    )),
  ]);
  const tbody = el("tbody", { class: "lib-catalog-tbody" });
  return el("div", { class: "lib-catalog-table-wrap" }, [
    el("table", { class: "lib-catalog-table" }, [thead, tbody]),
  ]);
}

function buildCatalogBottomBar(root) {
  const summary = el("div", { class: "lib-catalog-summary" }, [
    el("span", { class: "lib-catalog-summary-shown" }, t("library.catalog.summary.shown", { shown: "0", total: "0" })),
    el("span", { class: "lib-catalog-summary-sep" }, "·"),
    el("span", { class: "lib-catalog-summary-selected" }, t("library.catalog.summary.selected", { n: "0" })),
  ]);

  const selectAllBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost",
    onclick: () => {
      const filtered = filterCatalog(CATALOG.rows);
      for (const r of filtered) CATALOG.selected.add(r.id);
      renderCatalogTable(root);
    },
  }, t("library.catalog.btn.selectAll"));

  const clearBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost",
    onclick: () => {
      CATALOG.selected.clear();
      renderCatalogTable(root);
    },
  }, t("library.catalog.btn.clearSel"));

  const deleteBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-danger",
    onclick: async () => {
      if (CATALOG.selected.size === 0) return;
      if (!window.confirm(t("library.catalog.confirm.delete", {
        title: `${CATALOG.selected.size} books`,
      }))) return;
      for (const bookId of Array.from(CATALOG.selected)) {
        try { await window.api.library.deleteBook(bookId, true); }
        catch (e) { console.warn("[library.delete]", bookId, e); }
      }
      CATALOG.selected.clear();
      await renderCatalog(root);
    },
  }, t("library.catalog.btn.delete"));

  const crystallizeBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-primary",
    onclick: () => guardAndCrystallize(root),
  }, t("library.catalog.btn.crystallize"));

  /* Iter 9: Synthesize JSONL — запускает фон-синтез датасета из выбранной
     Qdrant-коллекции. Не зависит от выделения книг (работает с тем что
     УЖЕ принято в коллекцию), но требует чтобы коллекция была выбрана. */
  const synthesizeBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-secondary",
    onclick: () => void launchSynthesis(),
  }, t("library.catalog.btn.synthesize"));

  /* Cancel batch -- hidden until a batch is active. Kept as a sibling
     of crystallizeBtn so it can be toggled via display:none without
     remounting the bottom-bar. */
  const cancelBatchBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-danger lib-btn-cancel-batch",
    style: "display:none",
    onclick: () => void cancelBatchExtraction(),
  }, t("library.catalog.btn.cancelBatch"));

  /* Inline progress text (e.g. "Now: <book> (3/12)"); empty when idle. */
  const batchSummary = el("span", { class: "lib-catalog-batch-summary" }, "");

  return el("div", { class: "lib-catalog-bottombar" }, [
    summary,
    batchSummary,
    el("div", { class: "lib-catalog-bottom-actions" }, [
      selectAllBtn, clearBtn, deleteBtn, synthesizeBtn, crystallizeBtn, cancelBatchBtn,
    ]),
  ]);
}

/**
 * Iter 9: пускает фон-синтез датасета через `window.api.datasetV2.synthesize`.
 * Минималистичный UX: prompt → подтверждение → fire-and-forget.
 *
 * Не блокирует UI — результат попадает в файл, лог пишется рядом.
 * Пользователь видит alert с путём output + log сразу.
 */
async function launchSynthesis() {
  if (!STATE.targetCollection) {
    window.alert(t("library.catalog.guard.noCollection"));
    return;
  }

  /* Default output path использует timestamp чтобы не перезаписать
     прошлый прогон, и кладётся в release/datasets/ рядом с e2e-report. */
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const safeColl = STATE.targetCollection.replace(/[^a-z0-9-]/gi, "_");
  const defaultOut = `release/datasets/${safeColl}-${stamp}.jsonl`;

  const outputPath = window.prompt(
    t("library.catalog.synth.promptOutput", { coll: STATE.targetCollection }),
    defaultOut,
  );
  if (!outputPath) return;

  const pairsRaw = window.prompt(t("library.catalog.synth.promptPairs"), "2");
  if (!pairsRaw) return;
  const pairsPerConcept = Math.max(1, Math.min(5, parseInt(pairsRaw, 10) || 2));

  const includeReasoning = window.confirm(t("library.catalog.synth.confirmReasoning"));

  const confirm = window.confirm(
    t("library.catalog.synth.confirmStart", {
      coll: STATE.targetCollection,
      out: outputPath,
      pairs: String(pairsPerConcept),
      reasoning: includeReasoning ? "yes" : "no",
    }),
  );
  if (!confirm) return;

  let res;
  try {
    res = await window.api.datasetV2.synthesize({
      collection: STATE.targetCollection,
      outputPath,
      pairsPerConcept,
      includeReasoning,
      preset: "auto",
    });
  } catch (e) {
    window.alert(t("library.catalog.synth.errSpawn", { err: e instanceof Error ? e.message : String(e) }));
    return;
  }

  if (!res.ok) {
    window.alert(t("library.catalog.synth.errSpawn", { err: res.error || "unknown" }));
    return;
  }

  window.alert(t("library.catalog.synth.started", {
    pid: String(res.pid ?? "?"),
    out: outputPath,
    log: res.logPath ?? "(no log)",
  }));
}

/**
 * Guard rules before crystallization:
 *  - target collection must be picked
 *  - all selected books must be evaluated (not still queued/failed)
 *  - low-quality warning if any has quality < 50
 *
 * After guards pass, kicks off real `dataset-v2:start-batch` and lets the
 * subscription (subscribeBatchEvents) drive UI updates per book.
 */
function guardAndCrystallize(root) {
  if (BATCH.active) return; // double-click safety
  if (CATALOG.selected.size === 0) return;
  if (!STATE.targetCollection) {
    window.alert(t("library.catalog.guard.noCollection"));
    return;
  }
  const selectedRows = CATALOG.rows.filter((r) => CATALOG.selected.has(r.id));
  const unevaluated = selectedRows.filter((r) =>
    r.status === "imported" || r.status === "evaluating" || r.status === "failed" ||
    typeof r.qualityScore !== "number"
  );
  if (unevaluated.length > 0) {
    window.alert(t("library.catalog.guard.unevaluated", { n: String(unevaluated.length) }));
    return;
  }
  const lowQ = selectedRows.filter((r) => (r.qualityScore ?? 0) < 50);
  if (lowQ.length > 0 && !window.confirm(t("library.catalog.guard.lowQuality", { n: String(lowQ.length) }))) {
    return;
  }
  void startBatchExtraction(root, selectedRows.map((r) => r.id));
}

/**
 * Fire-and-forget startBatch. The IPC promise resolves only once the whole
 * batch is done (or fails) -- we await it here only to flip BATCH.active
 * back off on terminal states. Live progress comes from `dataset-v2:event`
 * (see subscribeBatchEvents in mountLibrary).
 */
async function startBatchExtraction(root, bookIds) {
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
  renderCatalogTable(root);

  try {
    const res = await window.api.datasetV2.startBatch({
      bookIds,
      targetCollection: STATE.targetCollection,
    });
    /* Resolve = batch reached natural end (could be all-skipped). The
       per-book accounting was already updated by events; we only need
       to publish a summary toast for the user. */
    window.alert(t("library.catalog.batch.done", {
      processed: String(res.processed),
      skipped: String(res.skipped.length),
      failed: String(BATCH.failed),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    /* AbortError / user-cancel surfaces here as "user-cancel"; treat
       both branches uniformly -- BATCH.active gets reset in finally. */
    const cancelled = /abort|cancel/i.test(msg);
    window.alert(cancelled
      ? t("library.catalog.batch.cancelled")
      : t("library.catalog.batch.failed", { error: msg }));
  } finally {
    BATCH.active = false;
    BATCH.currentBookId = null;
    BATCH.currentBookTitle = null;
    updateBatchUi(root);
    /* Re-pull catalog so SQLite-side status (`indexed`/`failed`) replaces
       optimistic in-flight state. */
    void renderCatalog(root);
  }
}

/**
 * Iter 7: правильная отмена батча.
 *
 * 1. cancelBatch(batchId) -- прерывает batch-loop ПЕРЕД следующей книгой.
 *    Все оставшиеся книги попадут в `skipped: "batch-cancelled"`.
 * 2. cancel(jobId) -- прерывает текущую runExtraction (HTTP-запрос к LM Studio
 *    отменяется). Книга помечается failed, а main-процесс выйдет из цикла,
 *    т.к. шаг 1 уже взвёл флаг.
 *
 * Без шага 1 цикл переходил к следующей книге после отмены текущей --
 * пользователь видел "продолжается крутится".
 */
async function cancelBatchExtraction() {
  if (!BATCH.active) return;
  if (!window.confirm(t("library.catalog.batch.confirmCancel"))) return;
  if (BATCH.batchId) {
    try {
      await window.api.datasetV2.cancelBatch(BATCH.batchId);
    } catch (err) {
      console.warn("[batch.cancelBatch] failed:", err);
    }
  }
  if (BATCH.lastJobId) {
    try {
      await window.api.datasetV2.cancel(BATCH.lastJobId);
    } catch (err) {
      console.warn("[batch.cancel] failed:", err);
    }
  }
}

/**
 * Single dispatcher for `dataset-v2:event` payloads. Mutates BATCH +
 * CATALOG.rows in place; callers re-render via updateBatchUi /
 * renderCatalogTable.
 */
function applyBatchEvent(root, ev) {
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
    } else if (ev.phase === "done") {
      /* No state change here -- BATCH.active is flipped by startBatchExtraction's finally. */
    }
    updateBatchUi(root);
    renderCatalogTable(root);
  }
  /* Non-batch stages (parse/extract/judge/...) carry per-book jobId so
     cancelBatchExtraction can target the right inner job, but otherwise
     don't move the catalog needle. */
}

/**
 * Reflects BATCH.* into the bottom-bar: button label/disabled, summary
 * text, optional Cancel button visibility.
 */
function updateBatchUi(root) {
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
      btn.textContent = t("library.catalog.btn.crystallize");
    }
  }
  if (cancelBtn) {
    cancelBtn.style.display = BATCH.active ? "" : "none";
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

function buildCatalogPane(root) {
  const toolbar = buildCatalogToolbar(root);
  const table = buildCatalogTable();
  const bottombar = buildCatalogBottomBar(root);
  const body = el("div", { class: "lib-catalog-body" }, [toolbar, table, bottombar]);
  return el("div", { class: "lib-pane lib-pane-catalog lib-pane-active" }, [body]);
}

/* ═══════════════════ IMPORT (Iter 5c) ═══════════════════ */

const IMPORT_STATE = {
  busy: false,
  /** @type {string|null} current importId for cancel. */
  importId: null,
  recursive: true,
  scanArchives: false,
};

function buildImportPane() {
  const recursiveCb = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    id: "lib-import-recursive",
    class: "lib-import-opt-cb",
  }));
  recursiveCb.checked = IMPORT_STATE.recursive;
  recursiveCb.addEventListener("change", () => {
    IMPORT_STATE.recursive = recursiveCb.checked;
  });

  const archivesCb = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    id: "lib-import-archives",
    class: "lib-import-opt-cb",
    title: t("library.import.opt.tooltip.scanArchives"),
  }));
  archivesCb.checked = IMPORT_STATE.scanArchives;
  archivesCb.addEventListener("change", () => {
    IMPORT_STATE.scanArchives = archivesCb.checked;
  });

  const opts = el("div", { class: "lib-import-opts" }, [
    el("label", { for: "lib-import-recursive", class: "lib-import-opt" }, [
      recursiveCb, el("span", {}, t("library.import.opt.recursive")),
    ]),
    el("label", {
      for: "lib-import-archives",
      class: "lib-import-opt",
      title: t("library.import.opt.tooltip.scanArchives"),
    }, [
      archivesCb, el("span", {}, t("library.import.opt.scanArchives")),
    ]),
  ]);

  const pickFolderBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-primary",
    onclick: () => importFromFolder(),
  }, t("library.import.btn.pickFolder"));

  const pickFilesBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost",
    onclick: () => importFromFiles(),
  }, t("library.import.btn.pickFiles"));

  const cancelBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-danger lib-import-cancel",
    style: "display:none",
    onclick: async () => {
      if (!IMPORT_STATE.importId) return;
      try { await window.api.library.cancelImport(IMPORT_STATE.importId); } catch { /* best effort */ }
    },
  }, t("library.import.btn.cancel"));

  const dropzone = el("div", {
    class: "lib-import-dropzone",
    role: "button",
    tabindex: "0",
    "aria-label": t("library.import.dropzone.title"),
    onclick: () => importFromFiles(),
    onkeydown: (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); importFromFiles(); }
    },
  }, [
    el("div", { class: "lib-import-dropzone-icon", "aria-hidden": "true" }, "+"),
    el("div", { class: "lib-import-dropzone-title" }, t("library.import.dropzone.title")),
    el("div", { class: "lib-import-dropzone-hint" }, t("library.import.dropzone.hint")),
  ]);

  const status = el("div", { class: "lib-import-status", "aria-live": "polite" }, "");

  const evaluatorPanel = el("div", { class: "lib-evaluator-panel" }, [
    el("div", { class: "lib-evaluator-title" }, t("library.import.evaluator.title")),
    el("div", { class: "lib-evaluator-state" }, t("library.import.evaluator.idle")),
  ]);

  const body = el("div", { class: "lib-import-body" }, [
    dropzone,
    el("div", { class: "lib-import-actions" }, [pickFolderBtn, pickFilesBtn, cancelBtn]),
    opts,
    status,
    evaluatorPanel,
  ]);

  return el("div", { class: "lib-pane lib-pane-import" }, [body]);
}

function renderImport(root) {
  void refreshEvaluatorState(root);
}

async function importFromFolder() {
  if (IMPORT_STATE.busy) return;
  /** @type {string|null} */
  let folderPath = null;
  try { folderPath = await window.api.library.pickFolder(); } catch { folderPath = null; }
  if (!folderPath) return;
  await runImport(async () =>
    window.api.library.importFolder({
      folderPath,
      recursive: IMPORT_STATE.recursive,
      scanArchives: IMPORT_STATE.scanArchives,
    }),
  );
}

async function importFromFiles() {
  if (IMPORT_STATE.busy) return;
  /** @type {string[]} */
  let paths = [];
  try {
    const r = /** @type {any} */ (await window.api.library.pickFiles());
    paths = Array.isArray(r) ? r : (r?.paths ?? []);
  } catch { paths = []; }
  if (paths.length === 0) return;
  await runImport(async () =>
    window.api.library.importFiles({
      paths,
      scanArchives: IMPORT_STATE.scanArchives,
    }),
  );
}

async function runImport(invoke) {
  const root = document.getElementById("library-root");
  if (!root) return;
  const status = root.querySelector(".lib-import-status");
  const cancelBtn = /** @type {HTMLElement|null} */ (root.querySelector(".lib-import-cancel"));
  IMPORT_STATE.busy = true;
  if (cancelBtn) cancelBtn.style.display = "";
  if (status) status.textContent = "...";
  try {
    const res = await invoke();
    IMPORT_STATE.importId = res.importId || null;
    if (status) status.textContent = t("library.import.progress.done", {
      added: String(res.added ?? 0),
      skipped: String((res.skipped ?? 0) + (res.duplicate ?? 0) + (res.failed ?? 0)),
    });
    void renderCatalog(root);
  } catch (e) {
    if (status) status.textContent = t("library.import.progress.failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    IMPORT_STATE.busy = false;
    IMPORT_STATE.importId = null;
    if (cancelBtn) cancelBtn.style.display = "none";
  }
}

async function refreshEvaluatorState(root) {
  const stateEl = root.querySelector(".lib-evaluator-state");
  if (!stateEl) return;
  try {
    const status = await window.api.library.evaluatorStatus();
    if (status && status.currentTitle) {
      stateEl.textContent = t("library.import.evaluator.busy", {
        title: status.currentTitle,
        n: String(status.queueSize ?? 0),
      });
    } else {
      stateEl.textContent = t("library.import.evaluator.idle");
    }
  } catch {
    /* keep previous text */
  }
}

/**
 * Top-bar: header (title + sub) + collection picker.
 * Sits above all tabs. Picker drives STATE.targetCollection.
 */
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
      STATE.collection = name; /* keep legacy code paths in sync */
      const legacyInput = /** @type {HTMLInputElement|null} */ (root.querySelector(".lib-collection-input"));
      if (legacyInput && legacyInput.value !== name) legacyInput.value = name;
    },
    onCreate: () => {
      /* refresh list, picker.refresh already called */
    },
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

function buildCollectionInput() {
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

function buildLibrarySummary() {
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

function buildOcrBadge() {
  return STATE.prefs.ocrSupported
    ? el("span", { class: "lib-ocr-badge lib-ocr-badge-ok", title: t("library.ocr.badge.ok.tooltip") },
        t("library.ocr.badge.ok").replace("{platform}", STATE.prefs.ocrPlatform))
    : el("span", { class: "lib-ocr-badge lib-ocr-badge-off", title: STATE.prefs.ocrReason || t("library.ocr.badge.off.tooltip") },
        t("library.ocr.badge.off"));
}

/**
 * Создаёт 4 action-кнопки и навешивает обработчики.
 * @returns {{ btnPick: HTMLButtonElement, btnOpenFiles: HTMLButtonElement, btnStart: HTMLButtonElement, btnCancel: HTMLButtonElement }}
 */
function buildLibraryActionButtons(root, listEl) {
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
    enqueueAndStart(books, root);
  });
  btnCancel.addEventListener("click", () => { cancelAll(root); });

  return { btnPick, btnOpenFiles, btnStart, btnCancel };
}

function subscribeScannerProgress(root, listEl) {
  if (unsubscribeProgress) unsubscribeProgress();
  unsubscribeProgress = window.api.scanner.onProgress((p) => {
    STATE.progress.set(p.bookSourcePath, p);
    renderBooks(listEl, root);
  });
}

function subscribeDownloadProgress(root) {
  if (unsubscribeDownloadProgress) unsubscribeDownloadProgress();
  unsubscribeDownloadProgress = window.api.bookhunter.onDownloadProgress((p) => {
    const candidateId = DOWNLOAD_BY_ID.get(p.downloadId);
    if (!candidateId) return;
    const cur = DOWNLOAD_STATE.get(candidateId);
    if (!cur) return;
    const reachedEnd = p.total !== null && p.downloaded >= p.total;
    DOWNLOAD_STATE.set(candidateId, {
      ...cur,
      downloaded: p.downloaded,
      total: p.total,
      status: reachedEnd ? "ingesting" : "downloading",
    });
    rerenderCard(candidateId, root);
  });
}

/**
 * Window-level guards: prevent the OS from navigating away from the app
 * when the user accidentally drops a file outside the dropzone.
 */
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

  const catalogPane = buildCatalogPane(root);
  const importPane = buildImportPane();
  const browsePane = el("div", { class: "lib-pane lib-pane-browse" }, [toolbar, dropzone, splitPane]);
  const searchPane = el("div", { class: "lib-pane lib-pane-search" }, [el("div", { class: "lib-search" })]);
  const historyPane = el("div", { class: "lib-pane lib-pane-history" }, [el("div", { class: "lib-history" })]);

  root.append(topBar, tabs, catalogPane, importPane, browsePane, searchPane, historyPane);

  subscribeScannerProgress(root, listEl);
  subscribeDownloadProgress(root);
  installWindowDropGuards(root);
  loadInitialLibraryData(root, coll.datalist, coll.input);

  /* Live updates from evaluator queue: re-render Catalog row + Import status. */
  CATALOG.unsubEvaluator = window.api.library.onEvaluatorEvent((ev) => {
    if (STATE.tab === "catalog") void renderCatalog(root);
    if (STATE.tab === "import") void refreshEvaluatorState(root);
    /* Always update visible quality/status if the affected book is currently rendered. */
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

  /* Live updates from multi-book crystallization batch (Iter 6). The
     dispatcher mutates BATCH/CATALOG in place and re-renders only the
     pieces that need it -- expensive `library.catalog` IPC is avoided
     until the batch terminates (then renderCatalog runs once for fresh
     persisted state). */
  CATALOG.unsubBatch = window.api.datasetV2.onEvent((ev) => {
    applyBatchEvent(root, ev);
  });

  refreshSummary(root);
  renderPreview(root);
  renderBooks(listEl, root);

  /* Catalog is the default tab -- prefetch its data so first render is instant. */
  void renderCatalog(root);
}

export function isLibraryBusy() {
  return STATE.activeIngests.size > 0 || STATE.queue.length > 0;
}
