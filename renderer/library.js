// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";

/** @typedef {{ absPath: string, fileName: string, ext: string, sizeBytes: number, mtimeMs: number }} BookFile */
/** @typedef {{ ingestId: string, phase: string, bookSourcePath: string, bookTitle: string, totalChunks: number, processedChunks: number, embeddedChunks: number, upsertedChunks: number, message?: string, errorMessage?: string }} ProgressEvent */
/** @typedef {{ collection: string, books: Array<{ bookSourcePath: string, fileName: string, status: "running"|"done"|"error"|"paused", totalChunks: number, processedChunks: number, startedAt: string, lastUpdatedAt: string, errorMessage?: string }>, totalBooks: number, totalChunks: number }} HistoryGroup */

let QUEUE_PARALLELISM = 3;

(async () => {
  try {
    const prefs = await window.api.preferences.getAll();
    if (prefs.ingestParallelism) QUEUE_PARALLELISM = prefs.ingestParallelism;
  } catch { /* use default */ }
})();

const STATE = {
  /** @type {"browse"|"history"} */
  tab: "browse",
  /** @type {BookFile[]} */
  books: [],
  /** @type {Map<string, BookFile>} */
  selected: new Map(),
  /** @type {Map<string, ProgressEvent>} */
  progress: new Map(),
  /** Set путей, которые уже есть в scanner-history (для smart resume) */
  /** @type {Set<string>} */
  knownPaths: new Set(),
  /** @type {string} */
  collection: "",
  /** @type {string[]} */
  collections: [],
  /** Активные ingest-ы по bookSourcePath → ingestId */
  /** @type {Map<string, string>} */
  activeIngests: new Map(),
  /** Очередь ожидающих книг (FIFO) */
  /** @type {BookFile[]} */
  queue: [],
  /** Selected для preview */
  /** @type {BookFile | null} */
  previewBook: null,
  /** @type {"idle"|"loading"|"ready"|"error"} */
  previewState: "idle",
  previewData: null,
  /** @type {HistoryGroup[]} */
  history: [],
  busy: false,
  paused: false,
};

let unsubscribeProgress = null;

function fmtMB(bytes) {
  if (!bytes) return "—";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function extBadge(ext) {
  return el("span", { class: `lib-ext lib-ext-${ext}` }, ext.toUpperCase());
}

function statusForBook(book) {
  const prog = STATE.progress.get(book.absPath);
  const known = STATE.knownPaths.has(book.absPath);
  if (!prog && known) {
    return el("span", { class: "lib-status lib-status-known" }, t("library.status.alreadyIngested"));
  }
  if (!prog) return el("span", { class: "lib-status lib-status-pending" }, t("library.status.pending"));
  if (prog.phase === "done") return el("span", { class: "lib-status lib-status-done" }, t("library.status.done"));
  if (prog.phase === "error") return el("span", { class: "lib-status lib-status-error" }, prog.errorMessage || t("library.status.error"));
  const pct = prog.totalChunks > 0 ? Math.floor((prog.processedChunks / prog.totalChunks) * 100) : 0;
  return el("span", { class: "lib-status lib-status-running" }, `${prog.phase} ${pct}% (${prog.processedChunks}/${prog.totalChunks})`);
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

function renderBooks(listEl, root) {
  clear(listEl);
  if (STATE.books.length === 0) {
    listEl.appendChild(el("div", { class: "lib-empty" }, t("library.empty")));
    return;
  }
  for (const b of STATE.books) listEl.appendChild(row(b, root));
}

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
      onclick: () => { STATE.previewBook = null; renderPreview(root); renderBooks(root.querySelector(".lib-list"), root); } }, "×"),
  ]);
  pane.appendChild(header);
  if (STATE.previewState === "loading") {
    pane.appendChild(el("div", { class: "lib-preview-loading" }, t("library.preview.loading")));
    return;
  }
  if (STATE.previewState === "error" || !STATE.previewData) {
    const msg = STATE.previewData?.error || "—";
    pane.appendChild(el("div", { class: "lib-preview-error" }, [t("library.preview.error") + ": ", msg]));
    return;
  }
  if (STATE.previewState !== "ready") return;
  const d = STATE.previewData;
  const meta = d.metadata ?? {};
  const stats = el("div", { class: "lib-preview-stats" }, [
    el("div", {}, [el("strong", {}, t("library.preview.stat.title") + ": "), meta.title ?? "—"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.author") + ": "), meta.author ?? "—"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.lang") + ": "), meta.language ?? "—"]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.sections") + ": "), String(d.sectionCount)]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.estChunks") + ": "), String(d.estimatedChunks)]),
    el("div", {}, [el("strong", {}, t("library.preview.stat.chars") + ": "), String(d.rawCharCount)]),
  ]);
  pane.appendChild(stats);
  if (Array.isArray(meta.warnings) && meta.warnings.length > 0) {
    const w = el("div", { class: "lib-preview-warnings" }, [
      el("strong", {}, t("library.preview.warnings") + ":"),
      ...meta.warnings.map((wm) => el("div", { class: "lib-warning" }, "• " + wm)),
    ]);
    pane.appendChild(w);

    /* Phase 6.0 prep: actionable hint for image-only PDFs */
    const hasOcrCandidate = meta.warnings.some((wm) => /scanned|image|OCR|no text/i.test(String(wm)));
    if (hasOcrCandidate && d.rawCharCount === 0) {
      pane.appendChild(
        el("div", { class: "lib-warning-ocr", role: "note" }, [
          el("span", { class: "lib-warning-ocr-icon", "aria-hidden": "true" }, "i"),
          el("div", {}, [
            el("span", { class: "lib-warning-ocr-title" }, t("library.preview.ocr.title")),
            el("span", { class: "lib-warning-ocr-body" }, t("library.preview.ocr.body")),
          ]),
        ])
      );
    }
  }
  const samples = el("div", { class: "lib-preview-samples" }, [
    el("strong", {}, t("library.preview.firstChunks") + ":"),
  ]);
  for (const c of d.sampleChunks ?? []) {
    samples.appendChild(
      el("div", { class: "lib-sample" }, [
        el("div", { class: "lib-sample-head" }, `${c.chapterTitle} · #${c.chunkIndex} · ${c.charCount} chars`),
        el("div", { class: "lib-sample-body" }, c.text),
      ])
    );
  }
  pane.appendChild(samples);
  const actions = el("div", { class: "lib-preview-actions" }, [
    el("button", { class: "lib-btn lib-btn-accent", type: "button",
      onclick: () => {
        STATE.selected.set(STATE.previewBook.absPath, STATE.previewBook);
        enqueueAndStart([STATE.previewBook], root);
      } }, t("library.preview.btn.ingestThis")),
  ]);
  pane.appendChild(actions);
}

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

async function probeFolder(root, listEl) {
  if (STATE.busy) return;
  STATE.busy = true;
  try {
    const files = await window.api.scanner.probeFolder();
    STATE.books = files;
    STATE.selected.clear();
    refreshSummary(root);
    renderBooks(listEl, root);
  } finally {
    STATE.busy = false;
  }
}

/* ─── Queue runner ─── */

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
  while (STATE.activeIngests.size < QUEUE_PARALLELISM && STATE.queue.length > 0) {
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
  try {
    const res = await window.api.scanner.startIngest({
      filePath: book.absPath,
      collection: STATE.collection,
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

/* ─── History tab ─── */

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
      el("span", { class: "lib-hist-meta" }, ` · ${group.totalBooks} ${t("library.history.books")} · ${group.totalChunks} ${t("library.history.chunks")}`),
    ]);
    const list = el("div", { class: "lib-hist-list" });
    for (const b of group.books) {
      list.appendChild(
        el("div", { class: "lib-hist-row" }, [
          el("span", { class: `lib-hist-status lib-hist-status-${b.status}` }, b.status),
          el("div", { class: "lib-hist-name", title: b.bookSourcePath }, b.fileName),
          el("div", { class: "lib-hist-counts" }, `${b.processedChunks}/${b.totalChunks}`),
          el("div", { class: "lib-hist-date" }, fmtDate(b.lastUpdatedAt)),
          el("button", { class: "lib-btn lib-btn-small", type: "button",
            onclick: async () => {
              if (!confirm(t("library.history.confirmDelete").replace("{book}", b.fileName).replace("{collection}", group.collection))) return;
              try {
                await window.api.scanner.deleteFromCollection(b.bookSourcePath, group.collection);
                await loadHistory();
                renderHistory(root);
              } catch (e) {
                alert(t("library.history.deleteFailed") + ": " + (e instanceof Error ? e.message : String(e)));
              }
            } }, t("library.history.btn.delete")),
        ])
      );
    }
    wrap.appendChild(el("div", { class: "lib-hist-group" }, [head, list]));
  }
}

/* ─── Search tab (BookHunter) ─── */

/** @type {{ query: string, results: Array<any>, searching: boolean }} */
const SEARCH_STATE = { query: "", results: [], searching: false };

function renderSearch(root) {
  const wrap = root.querySelector(".lib-search");
  if (!wrap) return;
  clear(wrap);

  const bar = el("div", { class: "lib-search-bar" }, [
    el("input", {
      type: "text",
      class: "lib-search-input",
      placeholder: t("library.search.placeholder"),
      value: SEARCH_STATE.query,
      id: "lib-search-q",
    }),
    el("button", {
      class: "lib-btn lib-btn-primary",
      type: "button",
      disabled: SEARCH_STATE.searching ? "true" : undefined,
      onclick: () => doSearch(root),
    }, SEARCH_STATE.searching ? "..." : t("library.search.btn")),
  ]);
  wrap.appendChild(bar);

  const qInput = wrap.querySelector("#lib-search-q");
  if (qInput) {
    qInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch(root);
    });
    qInput.addEventListener("input", (e) => {
      SEARCH_STATE.query = e.target.value;
    });
  }

  if (SEARCH_STATE.results.length === 0 && !SEARCH_STATE.searching) {
    wrap.appendChild(el("div", { class: "lib-search-hint" }, t("library.search.hint")));
    return;
  }

  const list = el("div", { class: "lib-search-results" });
  for (const r of SEARCH_STATE.results) {
    const fmts = (r.formats || []).map((f) => f.format || f).join(", ");
    const card = el("div", { class: "lib-search-card" }, [
      el("div", { class: "lib-search-title" }, r.title),
      el("div", { class: "lib-search-meta" }, [
        r.authors?.join(", ") || "—",
        r.year ? ` · ${r.year}` : "",
        ` · ${r.sourceTag}`,
        ` · ${r.license}`,
        fmts ? ` · ${fmts}` : "",
      ].join("")),
      r.description ? el("div", { class: "lib-search-desc" }, r.description.slice(0, 200)) : null,
      el("div", { class: "lib-search-actions" }, [
        el("button", {
          class: "lib-btn lib-btn-accent lib-btn-small",
          type: "button",
          onclick: async () => {
            if (!STATE.collection) {
              alert(t("library.alert.collection"));
              return;
            }
            try {
              card.querySelector(".lib-btn-accent").textContent = "...";
              const res = await window.api.bookhunter.downloadAndIngest({
                candidate: r,
                collection: STATE.collection,
              });
              card.querySelector(".lib-btn-accent").textContent = `done (${res.upserted} chunks)`;
              card.querySelector(".lib-btn-accent").disabled = true;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              alert(t("library.search.downloadFailed") + ": " + msg);
              card.querySelector(".lib-btn-accent").textContent = t("library.search.btn.downloadIngest");
            }
          },
        }, t("library.search.btn.downloadIngest")),
        r.webPageUrl
          ? el("a", {
              class: "lib-search-link",
              href: r.webPageUrl,
              target: "_blank",
              rel: "noopener",
            }, t("library.search.btn.openPage"))
          : null,
      ]),
    ]);
    list.appendChild(card);
  }
  wrap.appendChild(list);
}

async function doSearch(root) {
  const q = SEARCH_STATE.query.trim();
  if (!q || SEARCH_STATE.searching) return;
  SEARCH_STATE.searching = true;
  SEARCH_STATE.results = [];
  renderSearch(root);
  try {
    SEARCH_STATE.results = await window.api.bookhunter.search({ query: q, perSourceLimit: 6 });
  } catch (e) {
    alert(t("library.search.error") + ": " + (e instanceof Error ? e.message : String(e)));
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
  if (tab === "history") {
    loadHistory().then(() => renderHistory(root));
  }
  if (tab === "search") {
    renderSearch(root);
  }
}

export function mountLibrary(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  const tabs = el("div", { class: "lib-tabs" }, [
    el("button", { class: "lib-tab lib-tab-active", type: "button", "data-tab": "browse",
      onclick: () => switchTab("browse", root) }, t("library.tab.browse")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "search",
      onclick: () => switchTab("search", root) }, t("library.tab.search")),
    el("button", { class: "lib-tab", type: "button", "data-tab": "history",
      onclick: () => switchTab("history", root) }, t("library.tab.history")),
  ]);

  /* ----- Browse pane ----- */
  const collectionWrap = el("div", { class: "lib-collection-wrap" });
  const collectionLabel = el("label", { class: "lib-collection-label" }, t("library.collection.label"));
  const collectionInput = el("input", {
    type: "text",
    class: "lib-collection-input",
    placeholder: "library",
    list: "lib-collection-suggestions",
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
  const btnStart = el("button", { class: "lib-btn lib-btn-accent", type: "button", disabled: "true" }, t("library.btn.ingest"));
  const btnCancel = el("button", { class: "lib-btn", type: "button" }, t("library.btn.cancelAll"));
  const summary = el("div", { class: "lib-summary" }, [
    t("library.summary.selected") + " ",
    el("strong", { id: "lib-selected-count" }, "0"),
    " / ",
    el("strong", { id: "lib-total-count" }, "0"),
    " · ",
    t("library.summary.queue") + " ",
    el("strong", { id: "lib-queue-count" }, "0"),
  ]);

  const toolbar = el("div", { class: "lib-toolbar" }, [collectionWrap, btnPick, btnStart, btnCancel, summary]);

  const listEl = el("div", { class: "lib-list" });
  const previewEl = el("div", { class: "lib-preview" });

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

  btnStart.addEventListener("click", () => {
    const books = Array.from(STATE.selected.values());
    enqueueAndStart(books, root);
  });
  btnCancel.addEventListener("click", () => {
    cancelAll(root);
  });

  if (unsubscribeProgress) unsubscribeProgress();
  unsubscribeProgress = window.api.scanner.onProgress((p) => {
    STATE.progress.set(p.bookSourcePath, p);
    renderBooks(listEl, root);
  });

  const browsePane = el("div", { class: "lib-pane lib-pane-browse lib-pane-active" }, [toolbar, splitPane]);
  const searchPane = el("div", { class: "lib-pane lib-pane-search" }, [el("div", { class: "lib-search" })]);
  const historyPane = el("div", { class: "lib-pane lib-pane-history" }, [el("div", { class: "lib-history" })]);

  root.appendChild(tabs);
  root.appendChild(browsePane);
  root.appendChild(searchPane);
  root.appendChild(historyPane);
  refreshSummary(root);
  renderPreview(root);
  renderBooks(listEl, root);
}

export function isLibraryBusy() {
  return STATE.activeIngests.size > 0 || STATE.queue.length > 0;
}
