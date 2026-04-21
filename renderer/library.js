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

/** @typedef {{ absPath: string, fileName: string, ext: string, sizeBytes: number, mtimeMs: number }} BookFile */
/** @typedef {{ ingestId: string, phase: string, bookSourcePath: string, bookTitle: string, totalChunks: number, processedChunks: number, embeddedChunks: number, upsertedChunks: number, message?: string, errorMessage?: string }} ProgressEvent */
/** @typedef {{ collection: string, books: Array<{ bookSourcePath: string, fileName: string, status: "running"|"done"|"error"|"paused", totalChunks: number, processedChunks: number, startedAt: string, lastUpdatedAt: string, errorMessage?: string }>, totalBooks: number, totalChunks: number }} HistoryGroup */
/** @typedef {"none"|"ext"|"status"|"folder"} GroupMode */

const STATE = {
  /** @type {"browse"|"history"|"search"} */
  tab: "browse",
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
  root.querySelector(".lib-pane-browse")?.classList.toggle("lib-pane-active", tab === "browse");
  root.querySelector(".lib-pane-history")?.classList.toggle("lib-pane-active", tab === "history");
  root.querySelector(".lib-pane-search")?.classList.toggle("lib-pane-active", tab === "search");
  if (tab === "history") loadHistory().then(() => renderHistory(root));
  if (tab === "search") renderSearch(root);
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

export async function mountLibrary(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  await loadPrefs();

  const tabs = el("div", { class: "lib-tabs" }, [
    el("button", { class: "lib-tab lib-tab-active", type: "button", "data-tab": "browse",
      onclick: () => switchTab("browse", root) }, t("library.tab.browse")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "search",
      onclick: () => switchTab("search", root) }, t("library.tab.search")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "history",
      onclick: () => switchTab("history", root) }, t("library.tab.history")),
  ]);

  const collectionWrap = el("div", { class: "lib-collection-wrap" });
  const collectionLabel = el("label", { class: "lib-collection-label" }, t("library.collection.label"));
  const collectionInput = el("input", {
    type: "text", class: "lib-collection-input",
    placeholder: "library", list: "lib-collection-suggestions",
  });
  collectionInput.value = STATE.collection || "library";
  collectionInput.addEventListener("input", () => {
    STATE.collection = collectionInput.value.trim();
  });
  const datalist = el("datalist", { id: "lib-collection-suggestions" });
  collectionWrap.append(collectionLabel, collectionInput, datalist);

  Promise.all([loadCollections(), loadHistory()]).then(() => {
    clear(datalist);
    for (const c of STATE.collections) datalist.appendChild(el("option", { value: c }));
    if (!STATE.collection) {
      collectionInput.value = "library";
      STATE.collection = "library";
    }
    renderBooks(root.querySelector(".lib-list"), root);
  });

  const btnPick = el("button", { class: "lib-btn lib-btn-primary", type: "button" }, t("library.btn.pickFolder"));
  const btnOpenFiles = el("button", { class: "lib-btn", type: "button" }, t("library.btn.openFiles"));
  const btnStart = el("button", { class: "lib-btn lib-btn-accent", type: "button", disabled: "true" }, t("library.btn.ingest"));
  const btnCancel = el("button", { class: "lib-btn", type: "button" }, t("library.btn.cancelAll"));
  const summary = el("div", { class: "lib-summary" }, [
    t("library.summary.selected") + " ",
    el("strong", { id: "lib-selected-count" }, "0"),
    " / ",
    el("strong", { id: "lib-total-count" }, "0"),
    " - ",
    t("library.summary.queue") + " ",
    el("strong", { id: "lib-queue-count" }, "0"),
  ]);

  const listEl = el("div", { class: "lib-list" });
  const previewEl = el("div", { class: "lib-preview" });

  const groupControl = buildGroupControl(root, listEl);

  const ocrBadge = STATE.prefs.ocrSupported
    ? el("span", { class: "lib-ocr-badge lib-ocr-badge-ok", title: t("library.ocr.badge.ok.tooltip") },
        t("library.ocr.badge.ok").replace("{platform}", STATE.prefs.ocrPlatform))
    : el("span", { class: "lib-ocr-badge lib-ocr-badge-off", title: STATE.prefs.ocrReason || t("library.ocr.badge.off.tooltip") },
        t("library.ocr.badge.off"));

  const toolbar = el("div", { class: "lib-toolbar" }, [
    collectionWrap, btnPick, btnOpenFiles, btnStart, btnCancel, groupControl, ocrBadge, summary,
  ]);

  const dropzone = buildDropzone(root, listEl);
  const splitPane = el("div", { class: "lib-split" }, [listEl, previewEl]);

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

  if (unsubscribeProgress) unsubscribeProgress();
  unsubscribeProgress = window.api.scanner.onProgress((p) => {
    STATE.progress.set(p.bookSourcePath, p);
    renderBooks(listEl, root);
  });

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

  const browsePane = el("div", { class: "lib-pane lib-pane-browse lib-pane-active" }, [toolbar, dropzone, splitPane]);
  const searchPane = el("div", { class: "lib-pane lib-pane-search" }, [el("div", { class: "lib-search" })]);
  const historyPane = el("div", { class: "lib-pane lib-pane-history" }, [el("div", { class: "lib-history" })]);

  root.appendChild(tabs);
  root.appendChild(browsePane);
  root.appendChild(searchPane);
  root.appendChild(historyPane);

  /* Window-level guards: prevent the OS from navigating away from the app
     when the user accidentally drops a file outside the dropzone. */
  if (!root.dataset.dropGuard) {
    root.dataset.dropGuard = "1";
    window.addEventListener("dragover", (ev) => ev.preventDefault());
    window.addEventListener("drop", (ev) => ev.preventDefault());
  }

  refreshSummary(root);
  renderPreview(root);
  renderBooks(listEl, root);
}

export function isLibraryBusy() {
  return STATE.activeIngests.size > 0 || STATE.queue.length > 0;
}
