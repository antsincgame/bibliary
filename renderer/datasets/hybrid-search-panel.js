// @ts-check
/**
 * Hybrid Search Panel — простая бабушечная панель для поиска по коллекциям
 * Qdrant через `searchSmart` IPC (dense+rerank или hybrid+rerank).
 *
 * UI: одна строка ввода + dropdown выбора коллекции + кнопка "Найти" +
 * список результатов с подсветкой рейтинга. Показывает rerank score
 * как индикатор «насколько модель уверена что это релевантно».
 *
 * Цель — доказать end-to-end что hybrid search работает и пользователь
 * может реально искать по своим данным.
 */

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

const STATE = {
  query: "",
  collection: "",
  /** @type {string[]} */
  collections: [],
  /** @type {Array<{id: string, score: number, payload: Record<string, unknown>, rerankScore?: number}>} */
  results: [],
  loading: false,
  /** @type {string | null} */
  error: null,
  /** Сколько ms заняли последний поиск — для UX уверенности. */
  lastDurationMs: 0,
};

/** @returns {HTMLElement} */
export function buildHybridSearchPanel() {
  const wrap = el("section", { class: "ds-hybrid-panel" });
  const heading = el("h3", { class: "ds-hybrid-title" }, t("datasets.hybrid.title"));
  const subtitle = el("p", { class: "ds-hybrid-subtitle" }, t("datasets.hybrid.subtitle"));

  const collectionSelect = /** @type {HTMLSelectElement} */ (el("select", {
    class: "ds-hybrid-collection",
    onchange: (e) => {
      STATE.collection = String(/** @type {HTMLSelectElement} */(e.target).value);
    },
  }));
  collectionSelect.append(el("option", { value: "" }, t("datasets.hybrid.collection.placeholder")));

  const queryInput = /** @type {HTMLInputElement} */ (el("input", {
    class: "ds-hybrid-query",
    type: "search",
    placeholder: t("datasets.hybrid.placeholder"),
    oninput: (e) => {
      STATE.query = String(/** @type {HTMLInputElement} */(e.target).value);
    },
    onkeydown: (e) => {
      if (/** @type {KeyboardEvent} */(e).key === "Enter") doSearch();
    },
  }));

  const searchBtn = el("button", {
    type: "button",
    class: "ds-hybrid-search-btn",
    onclick: () => doSearch(),
  }, t("datasets.hybrid.search"));

  const status = el("div", { class: "ds-hybrid-status", "aria-live": "polite" }, "");
  const resultsBox = el("div", { class: "ds-hybrid-results" });

  /* Грузим список коллекций при монтировании. */
  async function refreshCollections() {
    try {
      const list = await window.api.qdrant.listDetailed();
      STATE.collections = (list || []).map((c) => c.name).sort();
      clear(collectionSelect);
      collectionSelect.append(el("option", { value: "" }, t("datasets.hybrid.collection.placeholder")));
      for (const name of STATE.collections) {
        collectionSelect.append(el("option", { value: name }, name));
      }
      if (STATE.collection && STATE.collections.includes(STATE.collection)) {
        collectionSelect.value = STATE.collection;
      }
    } catch (e) {
      console.warn("[hybrid-search] listDetailed failed:", e);
    }
  }

  async function doSearch() {
    if (!STATE.collection) {
      STATE.error = t("datasets.hybrid.error.noCollection");
      render();
      return;
    }
    const trimmed = STATE.query.trim();
    if (!trimmed) {
      STATE.error = t("datasets.hybrid.error.noQuery");
      render();
      return;
    }
    STATE.error = null;
    STATE.loading = true;
    STATE.results = [];
    render();

    const startedAt = Date.now();
    try {
      const r = await window.api.qdrant.searchSmart({
        collection: STATE.collection,
        query: trimmed,
        limit: 15,
      });
      STATE.results = Array.isArray(r) ? r : [];
      STATE.lastDurationMs = Date.now() - startedAt;
    } catch (err) {
      STATE.error = err instanceof Error ? err.message : String(err);
    } finally {
      STATE.loading = false;
      render();
    }
  }

  function render() {
    clear(status);
    if (STATE.loading) {
      status.append(el("span", { class: "ds-hybrid-loading" }, t("datasets.hybrid.searching")));
    } else if (STATE.error) {
      status.append(el("span", { class: "ds-hybrid-error" }, STATE.error));
    } else if (STATE.results.length > 0) {
      status.append(
        el("span", { class: "ds-hybrid-meta" },
          t("datasets.hybrid.found", {
            count: String(STATE.results.length),
            ms: String(STATE.lastDurationMs),
          })),
      );
    }

    clear(resultsBox);
    for (let i = 0; i < STATE.results.length; i++) {
      const r = STATE.results[i];
      resultsBox.append(buildResultCard(i + 1, r));
    }
  }

  /* Initial mount. */
  void refreshCollections();
  render();

  const controls = el("div", { class: "ds-hybrid-controls" }, [
    collectionSelect,
    queryInput,
    searchBtn,
  ]);

  wrap.append(heading, subtitle, controls, status, resultsBox);
  return wrap;
}

/**
 * @param {number} num
 * @param {{id: string, score: number, payload: Record<string, unknown>, rerankScore?: number}} r
 * @returns {HTMLElement}
 */
function buildResultCard(num, r) {
  const text = extractText(r.payload);
  const title = extractTitle(r.payload);
  const subtitle = extractSubtitle(r.payload);

  const scoreLabel = typeof r.rerankScore === "number"
    ? t("datasets.hybrid.score.rerank", { value: r.rerankScore.toFixed(2) })
    : t("datasets.hybrid.score.dense", { value: r.score.toFixed(3) });

  const headerEls = [
    el("span", { class: "ds-hybrid-num" }, `#${num}`),
    title ? el("span", { class: "ds-hybrid-result-title" }, title) : null,
    el("span", { class: "ds-hybrid-result-score" }, scoreLabel),
  ].filter(Boolean);

  const bodyEls = [];
  if (subtitle) bodyEls.push(el("div", { class: "ds-hybrid-result-sub" }, subtitle));
  if (text) bodyEls.push(el("div", { class: "ds-hybrid-result-text" }, truncate(text, 320)));

  return el("article", { class: "ds-hybrid-result-card" }, [
    el("header", { class: "ds-hybrid-result-head" }, headerEls),
    el("div", { class: "ds-hybrid-result-body" }, bodyEls),
  ]);
}

/** @param {Record<string, unknown>} p */
function extractText(p) {
  if (!p) return "";
  if (typeof p.text === "string") return p.text;
  if (typeof p.essence === "string") return p.essence;
  if (typeof p.description === "string") return p.description;
  return "";
}

/** @param {Record<string, unknown>} p */
function extractTitle(p) {
  if (!p) return "";
  if (typeof p.bookTitle === "string" && p.bookTitle.length > 0) return p.bookTitle;
  if (typeof p.docTitle === "string" && p.docTitle.length > 0) return p.docTitle;
  if (typeof p.chapterTitle === "string" && p.chapterTitle.length > 0) return p.chapterTitle;
  if (typeof p.cipher === "string" && p.cipher.length > 0) return p.cipher;
  return "";
}

/** @param {Record<string, unknown>} p */
function extractSubtitle(p) {
  if (!p) return "";
  const parts = [];
  if (typeof p.bookAuthor === "string" && p.bookAuthor.length > 0) parts.push(p.bookAuthor);
  if (typeof p.domain === "string" && p.domain.length > 0) parts.push(p.domain);
  if (typeof p.chapterIndex === "number") parts.push(`ch.${p.chapterIndex}`);
  if (typeof p.illustrationId === "string") parts.push(p.illustrationId);
  return parts.join(" · ");
}

/**
 * @param {string} s
 * @param {number} max
 */
function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max).trim() + "…";
}
