// @ts-check
/**
 * Search tab (BookHunter): search for books online, download & ingest.
 *
 * UI унифицирован с каталогом: таблица с колонками
 * (название, автор, год, источник, лицензия, форматы, действия).
 * Прогресс поиска по источникам — видимый, в шапке.
 */
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { showAlert } from "../components/ui-dialog.js";
import { STATE, SEARCH_STATE, DOWNLOAD_STATE, DOWNLOAD_BY_ID } from "./state.js";
import { formatBytes, cssEscape, makeDownloadId } from "./format.js";

/** Локальное состояние прогресса поиска (только для UI). */
const PROGRESS = {
  /** @type {boolean} */
  active: false,
  /** @type {Array<{tag: string, count: number, error?: string, done: boolean}>} */
  sources: [],
  /** @type {number | null} */
  total: null,
};

const SOURCE_LABELS = {
  gutendex: "Project Gutenberg",
  archive: "Internet Archive",
  openlibrary: "Open Library",
  arxiv: "arXiv (статьи)",
};

let unsubSearchProgress = null;

export function renderSearch(root) {
  const wrap = root.querySelector(".lib-search");
  if (!wrap) return;
  clear(wrap);

  /* Подписка на прогресс делается один раз */
  if (!unsubSearchProgress) {
    unsubSearchProgress = window.api.bookhunter.onSearchProgress((ev) => {
      if (ev.phase === "start") {
        PROGRESS.active = true;
        PROGRESS.sources = [];
        PROGRESS.total = typeof ev.total === "number" ? ev.total : null;
      } else if (ev.phase === "source-done") {
        PROGRESS.sources.push({
          tag: String(ev.source ?? "?"),
          count: Number(ev.count ?? 0),
          error: ev.error,
          done: true,
        });
      } else if (ev.phase === "done") {
        PROGRESS.active = false;
      }
      /* Перерисовать только шапку прогресса, чтобы не дёргать всю страницу */
      const head = root.querySelector(".lib-search-progress-head");
      if (head) {
        head.replaceWith(buildSearchProgressHead());
      }
    });
  }

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
    }, SEARCH_STATE.searching ? t("library.search.btn.searching") : t("library.search.btn")),
  ]);
  wrap.appendChild(bar);

  /* Видимый прогресс по источникам */
  wrap.appendChild(buildSearchProgressHead());

  /* Подсказка по источникам (где ищем + как добавить новые) */
  const sourcesHint = el("div", { class: "lib-search-sources" }, [
    el("div", { class: "lib-search-sources-row" }, [
      el("strong", { class: "lib-search-sources-title" }, t("library.search.sources.title") + ": "),
      el("span", { class: "lib-search-sources-list" }, t("library.search.sources.list")),
    ]),
    el("div", { class: "lib-search-sources-add" }, t("library.search.sources.addNew")),
  ]);
  wrap.appendChild(sourcesHint);

  const qInput = wrap.querySelector("#lib-search-q");
  if (qInput) {
    qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(root); });
    qInput.addEventListener("input", (e) => { SEARCH_STATE.query = /** @type {HTMLInputElement} */ (e.target).value; });
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

  /* Сводка: сколько нашли + подсказка про релевантность */
  if (SEARCH_STATE.results.length > 0) {
    wrap.appendChild(el("div", { class: "lib-search-summary" },
      t("library.search.summary", { n: String(SEARCH_STATE.results.length) }),
    ));
  }

  /* Таблица результатов — унифицирована с каталогом */
  const table = buildResultsTable(root);
  wrap.appendChild(table);
}

function buildSearchProgressHead() {
  const head = el("div", { class: "lib-search-progress-head" });

  if (!PROGRESS.active && PROGRESS.sources.length === 0) {
    return head;
  }

  const items = ["gutendex", "archive", "openlibrary", "arxiv"].map((tag) => {
    const found = PROGRESS.sources.find((s) => s.tag === tag);
    const label = SOURCE_LABELS[/** @type {keyof typeof SOURCE_LABELS} */ (tag)] || tag;
    let status = "…";
    let cls = "lib-search-source-pending";
    if (found) {
      if (found.error) {
        status = "✕";
        cls = "lib-search-source-error";
      } else {
        status = `✓ ${found.count}`;
        cls = found.count > 0 ? "lib-search-source-ok" : "lib-search-source-empty";
      }
    } else if (!PROGRESS.active) {
      return null;
    }
    return el("span", {
      class: `lib-search-source-pill ${cls}`,
      title: found?.error || label,
    }, [
      el("span", { class: "lib-search-source-name" }, label),
      el("span", { class: "lib-search-source-status" }, status),
    ]);
  }).filter(Boolean);

  if (items.length > 0) {
    head.appendChild(el("div", { class: "lib-search-progress-pills" }, items));
  }

  if (PROGRESS.active) {
    head.appendChild(el("div", { class: "lib-search-progress-note" },
      t("library.search.progress.searching"),
    ));
  }

  return head;
}

function buildResultsTable(root) {
  const wrapper = el("div", { class: "lib-catalog-table-wrap lib-search-table-wrap" });

  const thead = el("thead", {}, el("tr", {}, [
    el("th", { class: "lib-th lib-th-title" }, t("library.search.col.title")),
    el("th", { class: "lib-th" }, t("library.search.col.authors")),
    el("th", { class: "lib-th lib-th-num" }, t("library.search.col.year")),
    el("th", { class: "lib-th" }, t("library.search.col.source")),
    el("th", { class: "lib-th" }, t("library.search.col.license")),
    el("th", { class: "lib-th" }, t("library.search.col.formats")),
    el("th", { class: "lib-th lib-th-actions" }, t("library.search.col.actions")),
  ]));

  const tbody = el("tbody", {});
  for (const r of SEARCH_STATE.results) {
    tbody.appendChild(buildResultRow(r, root));
  }

  const table = el("table", { class: "lib-catalog-table lib-search-table" }, [thead, tbody]);
  wrapper.appendChild(table);
  return wrapper;
}

function buildResultRow(candidate, root) {
  const fmts = (candidate.formats || []).map((f) => f.format || f).join(", ");
  const dlState = DOWNLOAD_STATE.get(candidate.id);

  const actionsCell = el("td", { class: "lib-td lib-td-actions" });
  const tr = el("tr", { class: "lib-search-row", "data-candidate-id": candidate.id }, [
    el("td", { class: "lib-td lib-td-title" }, [
      el("div", { class: "lib-search-title" }, candidate.title || "—"),
      candidate.description
        ? el("div", { class: "lib-search-desc" }, candidate.description.slice(0, 200))
        : null,
    ]),
    el("td", { class: "lib-td" }, candidate.authors?.join(", ") || "—"),
    el("td", { class: "lib-td lib-td-num" }, candidate.year ? String(candidate.year) : "—"),
    el("td", { class: "lib-td" }, SOURCE_LABELS[candidate.sourceTag] || candidate.sourceTag),
    el("td", { class: "lib-td" }, candidate.license),
    el("td", { class: "lib-td" }, fmts || "—"),
    actionsCell,
  ]);

  refreshSearchRowActions(tr, candidate, root, dlState);
  return tr;
}

function refreshSearchRowActions(tr, candidate, root, dlState) {
  const actionsCell = tr.querySelector(".lib-td-actions");
  if (!actionsCell) return;
  clear(actionsCell);

  if (dlState && (dlState.status === "downloading" || dlState.status === "ingesting")) {
    const pct = dlState.total ? Math.min(100, Math.floor((dlState.downloaded / dlState.total) * 100)) : null;
    const label = dlState.status === "ingesting"
      ? t("library.search.status.ingesting")
      : pct !== null
        ? `${pct}% (${formatBytes(dlState.downloaded)}/${formatBytes(dlState.total)})`
        : `${formatBytes(dlState.downloaded)}`;
    actionsCell.appendChild(
      el("div", { class: "lib-search-progress", role: "status", "aria-live": "polite" }, [
        el("div", { class: "lib-search-progress-bar" }, [
          el("div", { class: "lib-search-progress-fill", style: `width: ${pct ?? 50}%` }),
        ]),
        el("div", { class: "lib-search-progress-label" }, label),
      ])
    );
    actionsCell.appendChild(
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
    actionsCell.appendChild(el("button", {
      class: "lib-btn lib-btn-accent lib-btn-small", type: "button", disabled: "true",
    }, dlState.message || t("library.search.status.done")));
  } else if (dlState?.status === "error" || dlState?.status === "cancelled") {
    actionsCell.appendChild(el("div", { class: "lib-search-error-inline" }, dlState.message || dlState.status));
    actionsCell.appendChild(el("button", {
      class: "lib-btn lib-btn-accent lib-btn-small", type: "button",
      onclick: () => startCardDownload(candidate, root),
    }, t("library.search.btn.retry")));
  } else {
    actionsCell.appendChild(el("button", {
      class: "lib-btn lib-btn-accent lib-btn-small", type: "button",
      onclick: () => startCardDownload(candidate, root),
    }, t("library.search.btn.downloadIngest")));
  }

  if (candidate.webPageUrl) {
    /* В Electron <a target="_blank"> по умолчанию открывает пустое окно
       — гарантированно открываем во внешнем браузере через preload IPC. */
    const link = el("button", {
      class: "lib-btn lib-btn-small lib-search-link",
      type: "button",
      title: t("library.search.btn.openPage.title"),
      onclick: async () => {
        try {
          const api = /** @type {any} */ (window).api;
          if (typeof api?.system?.openExternal === "function") {
            await api.system.openExternal(candidate.webPageUrl);
          } else {
            window.open(candidate.webPageUrl, "_blank", "noopener,noreferrer");
          }
        } catch (e) {
          console.warn("[search] openExternal failed:", e);
          await showAlert(t("library.search.openExternalFallback", { url: candidate.webPageUrl }));
        }
      },
    }, t("library.search.btn.openPage"));
    actionsCell.appendChild(link);
  }
}

async function startCardDownload(candidate, root) {
  if (!STATE.collection) { await showAlert(t("library.alert.collection")); return; }
  const cur = DOWNLOAD_STATE.get(candidate.id);
  if (cur && (cur.status === "downloading" || cur.status === "ingesting")) return;
  const downloadId = makeDownloadId();
  const initial = { downloadId, downloaded: 0, total: null, status: "downloading" };
  DOWNLOAD_STATE.set(candidate.id, initial);
  DOWNLOAD_BY_ID.set(downloadId, candidate.id);
  rerenderRow(candidate.id, root);
  try {
    const res = await window.api.bookhunter.downloadAndIngest({
      candidate, collection: STATE.collection, downloadId,
    });
    DOWNLOAD_STATE.set(candidate.id, {
      downloadId, downloaded: 0, total: 0,
      status: "done",
      message: t("library.search.status.doneCount").replace("{count}", String(res.upserted)),
    });
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
    rerenderRow(candidate.id, root);
  }
}

function updateDownloadStatus(candidateId, status, message, root) {
  const cur = DOWNLOAD_STATE.get(candidateId);
  if (!cur) return;
  DOWNLOAD_STATE.set(candidateId, { ...cur, status, message });
  rerenderRow(candidateId, root);
}

function rerenderRow(candidateId, root) {
  const tr = root.querySelector(`.lib-search-row[data-candidate-id="${cssEscape(candidateId)}"]`);
  if (!tr) return;
  const candidate = SEARCH_STATE.results.find((r) => r.id === candidateId);
  if (!candidate) return;
  refreshSearchRowActions(tr, candidate, root, DOWNLOAD_STATE.get(candidateId));
}

async function doSearch(root) {
  const q = SEARCH_STATE.query.trim();
  if (!q || SEARCH_STATE.searching) return;
  SEARCH_STATE.searching = true;
  SEARCH_STATE.results = [];
  SEARCH_STATE.error = "";
  PROGRESS.active = true;
  PROGRESS.sources = [];
  renderSearch(root);
  try {
    /* perSourceLimit берём из preferences (Settings → Поиск). Если значение
       не передавать — backend сам подхватит prefs. Так настройка реально
       влияет на поиск. */
    SEARCH_STATE.results = await window.api.bookhunter.search({ query: q });
  } catch (e) {
    SEARCH_STATE.error = e instanceof Error ? e.message : String(e);
  } finally {
    SEARCH_STATE.searching = false;
    PROGRESS.active = false;
    renderSearch(root);
  }
}

/**
 * Subscribe to download progress events from BookHunter.
 * @param {HTMLElement} root
 * @returns {() => void} unsubscribe fn
 */
export function subscribeDownloadProgress(root) {
  return window.api.bookhunter.onDownloadProgress((p) => {
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
    rerenderRow(candidateId, root);
  });
}
