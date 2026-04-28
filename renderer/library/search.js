// @ts-check
/**
 * Search tab (BookHunter): search for books online, download & ingest.
 */
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { showAlert } from "../components/ui-dialog.js";
import { STATE, SEARCH_STATE, DOWNLOAD_STATE, DOWNLOAD_BY_ID } from "./state.js";
import { formatBytes, cssEscape, makeDownloadId } from "./format.js";

export function renderSearch(root) {
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

  /* Баннер с подсказкой по источникам (где ищем + как добавить новые).
     Используется и когда результатов ещё нет, и над списком — для напоминания. */
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
    /* В Electron <a target="_blank"> по умолчанию открывает пустое окно
       (BrowserWindow без navigation handler) — пользователь видит белый
       экран. Гарантированно открываем во внешнем браузере через preload IPC
       (system.openExternal → shell.openExternal). */
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
    actionsWrap.appendChild(link);
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
    rerenderCard(candidateId, root);
  });
}
