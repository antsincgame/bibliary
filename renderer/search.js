// @ts-check
/**
 * Семантический поиск по Qdrant-коллекциям.
 *
 * Использует уже существующий IPC `qdrant:search`, который сам встроенно
 * вызывает `embedQuery` (multilingual-e5-small, 384d) если получает `query`
 * вместо вектора. Ничего собственного embedder'у тут не нужно.
 *
 * UI:
 *   - Picker коллекции (только непустые, с количеством точек)
 *   - Текстовое поле запроса + кнопка «Найти» (Enter тоже)
 *   - Слайдер scoreThreshold 0..1
 *   - Список карточек: score, snippet, метаданные (книга, глава, тэги)
 *   - Клик по карточке → копировать путь к книге (для MVP).
 *
 * Edge cases:
 *   - Qdrant offline → сразу баннер с инструкцией.
 *   - Embedder cold-start (первые 3-5 секунд первого запроса) → loader.
 *   - Пустой запрос → no-op.
 *   - Нет коллекций / коллекция пустая → пустое состояние.
 */

import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { showAlert } from "./components/ui-dialog.js";

const STATE = {
  /** @type {string} */
  collection: "",
  /** @type {Array<{ name: string; pointsCount: number }>} */
  collections: [],
  /** @type {string} */
  query: "",
  /** @type {number} */
  threshold: 0.45,
  /** @type {number} */
  limit: 20,
  /** @type {boolean} */
  loading: false,
  /** @type {boolean} */
  warming: false,
  /** @type {{ url: string; online: boolean } | null} */
  cluster: null,
  /** @type {string | null} */
  error: null,
  /** @type {Array<{ id: string; score: number; payload: Record<string, unknown> }>} */
  results: [],
  /** @type {boolean} */
  searched: false,
};

let isMounted = false;

export function isSearchBusy() {
  return STATE.loading;
}

export async function mountSearch(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") {
    renderResults(root);
    return;
  }
  root.dataset.mounted = "1";
  clear(root);
  isMounted = true;

  await hydrateDefaults();

  const layout = el("div", { class: "search-page" }, [
    buildHeader(root),
    buildControls(root),
    el("div", { class: "search-results", id: "search-results" }),
  ]);
  root.appendChild(layout);

  renderClusterStatus(root);
  void loadCollections(root);
  renderResults(root);
}

async function hydrateDefaults() {
  try {
    const prefs = /** @type {any} */ (await window.api.preferences.getAll());
    if (typeof prefs?.searchScoreThreshold === "number") {
      STATE.threshold = Math.max(0, Math.min(1, prefs.searchScoreThreshold));
    }
    if (typeof prefs?.qdrantSearchLimit === "number" && prefs.qdrantSearchLimit > 0) {
      STATE.limit = Math.min(200, Math.floor(prefs.qdrantSearchLimit));
    }
  } catch (_e) { /* tolerate: prefs read non-critical */ }
}

function buildHeader(_root) {
  return el("header", { class: "search-header" }, [
    el("div", { class: "search-title-row" }, [
      el("h1", { class: "search-h" }, t("search.title")),
      el("span", { class: "search-cluster", id: "search-cluster" }, ""),
    ]),
    el("p", { class: "search-sub" }, t("search.subtitle")),
  ]);
}

function buildControls(root) {
  const collectionSelect = /** @type {HTMLSelectElement} */ (
    el("select", {
      class: "search-collection",
      id: "search-collection",
      onchange: (e) => {
        STATE.collection = String(/** @type {HTMLSelectElement} */ (e.target).value || "");
      },
    })
  );
  const placeholder = el("option", { value: "" }, t("search.collection.loading"));
  collectionSelect.appendChild(placeholder);

  const refreshBtn = el(
    "button",
    {
      class: "search-refresh",
      type: "button",
      title: t("search.collection.refresh"),
      onclick: () => { void loadCollections(root); },
    },
    "↻",
  );

  const queryInput = /** @type {HTMLInputElement} */ (
    el("input", {
      class: "search-query",
      id: "search-query",
      type: "search",
      placeholder: t("search.placeholder"),
      value: STATE.query,
      oninput: (e) => {
        STATE.query = String(/** @type {HTMLInputElement} */ (e.target).value || "");
      },
      onkeydown: (e) => {
        const ev = /** @type {KeyboardEvent} */ (e);
        if (ev.key === "Enter") {
          ev.preventDefault();
          void runSearch(root);
        }
      },
    })
  );

  const thresholdLabel = el("label", { class: "search-threshold-label", for: "search-threshold" },
    `${t("search.threshold")} `);
  const thresholdValue = el("span", { class: "search-threshold-value", id: "search-threshold-value" },
    STATE.threshold.toFixed(2));
  const thresholdInput = /** @type {HTMLInputElement} */ (
    el("input", {
      class: "search-threshold",
      id: "search-threshold",
      type: "range",
      min: "0",
      max: "1",
      step: "0.05",
      value: String(STATE.threshold),
      oninput: (e) => {
        const v = Number(/** @type {HTMLInputElement} */ (e.target).value);
        STATE.threshold = Number.isFinite(v) ? v : 0.45;
        const node = root.querySelector("#search-threshold-value");
        if (node) node.textContent = STATE.threshold.toFixed(2);
      },
    })
  );

  const submitBtn = el(
    "button",
    {
      class: "search-submit cv-btn cv-btn-accent",
      type: "button",
      onclick: () => { void runSearch(root); },
    },
    t("search.submit"),
  );

  return el("div", { class: "search-controls" }, [
    el("div", { class: "search-row search-row-collection" }, [
      el("label", { class: "search-label", for: "search-collection" }, t("search.collection.label")),
      collectionSelect,
      refreshBtn,
    ]),
    el("div", { class: "search-row search-row-query" }, [
      queryInput,
      submitBtn,
    ]),
    el("div", { class: "search-row search-row-threshold" }, [
      thresholdLabel,
      thresholdInput,
      thresholdValue,
    ]),
  ]);
}

async function loadCollections(root) {
  const select = /** @type {HTMLSelectElement|null} */ (root.querySelector("#search-collection"));
  if (!select) return;
  select.disabled = true;
  try {
    const cluster = await window.api.qdrant.cluster();
    STATE.cluster = cluster ? { url: cluster.url, online: cluster.online } : null;
    renderClusterStatus(root);
    if (!cluster?.online) {
      select.innerHTML = "";
      select.appendChild(el("option", { value: "" }, t("search.qdrant_offline")));
      STATE.collections = [];
      return;
    }
    const list = await window.api.qdrant.listDetailed();
    STATE.collections = list.map((c) => ({ name: c.name, pointsCount: c.pointsCount }));
    select.innerHTML = "";
    if (STATE.collections.length === 0) {
      select.appendChild(el("option", { value: "" }, t("search.no_collections")));
      STATE.collection = "";
      return;
    }
    for (const c of STATE.collections) {
      const label = c.pointsCount > 0
        ? `${c.name} · ${c.pointsCount}`
        : `${c.name} · ${t("search.collection.empty")}`;
      const o = /** @type {HTMLOptionElement} */ (el("option", { value: c.name }, label));
      if (c.pointsCount === 0) o.disabled = true;
      select.appendChild(o);
    }
    /* Auto-pick: первая непустая, либо предыдущий выбор если он ещё в списке. */
    const previous = STATE.collection;
    const firstNonEmpty = STATE.collections.find((c) => c.pointsCount > 0)?.name ?? "";
    const valid = STATE.collections.some((c) => c.name === previous && c.pointsCount > 0);
    STATE.collection = valid ? previous : firstNonEmpty;
    select.value = STATE.collection;
  } catch (err) {
    console.error("[search] loadCollections failed:", err);
    select.innerHTML = "";
    select.appendChild(el("option", { value: "" }, t("search.error")));
    STATE.collections = [];
  } finally {
    select.disabled = false;
  }
}

function renderClusterStatus(root) {
  const node = root.querySelector("#search-cluster");
  if (!node) return;
  if (!STATE.cluster) {
    node.textContent = "";
    node.className = "search-cluster";
    return;
  }
  const online = STATE.cluster.online;
  node.textContent = online
    ? `${t("search.cluster.online")} · ${STATE.cluster.url}`
    : `${t("search.cluster.offline")} · ${STATE.cluster.url}`;
  node.className = `search-cluster ${online ? "search-cluster-online" : "search-cluster-offline"}`;
}

async function runSearch(root) {
  const query = STATE.query.trim();
  if (!query) {
    await showAlert(t("search.empty_query"));
    return;
  }
  if (!STATE.collection) {
    await showAlert(t("search.empty_collection"));
    return;
  }
  if (STATE.loading) return;
  STATE.loading = true;
  STATE.warming = !STATE.searched;
  STATE.error = null;
  STATE.results = [];
  STATE.searched = true;
  renderResults(root);
  try {
    const hits = await window.api.qdrant.search({
      collection: STATE.collection,
      query,
      limit: STATE.limit,
      scoreThreshold: STATE.threshold,
    });
    STATE.results = Array.isArray(hits) ? hits : [];
  } catch (err) {
    console.error("[search] runSearch failed:", err);
    STATE.error = err instanceof Error ? err.message : String(err);
  } finally {
    STATE.loading = false;
    STATE.warming = false;
    if (isMounted) renderResults(root);
  }
}

function renderResults(root) {
  const wrap = root.querySelector("#search-results");
  if (!wrap) return;
  clear(wrap);

  if (STATE.loading) {
    wrap.appendChild(el("div", { class: "search-loading" },
      STATE.warming ? t("search.embedder_warming") : t("search.loading")));
    return;
  }

  if (STATE.error) {
    wrap.appendChild(el("div", { class: "search-error" }, [
      el("div", { class: "search-error-title" }, t("search.error")),
      el("div", { class: "search-error-body" }, STATE.error),
    ]));
    return;
  }

  if (!STATE.searched) {
    wrap.appendChild(el("div", { class: "search-hint" }, t("search.intro")));
    return;
  }

  if (STATE.results.length === 0) {
    wrap.appendChild(el("div", { class: "search-empty" }, t("search.no_results")));
    return;
  }

  const summary = t("search.summary").replace("{count}", String(STATE.results.length));
  wrap.appendChild(el("div", { class: "search-summary" }, summary));

  for (const hit of STATE.results) {
    wrap.appendChild(buildResultCard(hit));
  }
}

function buildResultCard(hit) {
  const payload = hit.payload || {};
  const title = pickStr(payload, ["bookTitle", "title", "name"]) || "—";
  const author = pickStr(payload, ["bookAuthor", "author", "authors"]);
  const chapter = pickStr(payload, ["chapterTitle", "chapter"]);
  const snippet = pickStr(payload, ["text", "snippet", "chunkText", "description"]) || "";
  const path = pickStr(payload, ["bookSourcePath", "sourcePath", "path"]) || "";
  const tags = Array.isArray(payload.tags) ? /** @type {string[]} */ (payload.tags) : [];

  const head = el("div", { class: "search-result-head" }, [
    el("div", { class: "search-result-score" }, hit.score.toFixed(3)),
    el("div", { class: "search-result-title" }, title),
  ]);

  const meta = el("div", { class: "search-result-meta" }, [
    author ? el("span", { class: "search-result-author" }, author) : null,
    chapter ? el("span", { class: "search-result-chapter" }, chapter) : null,
    ...tags.slice(0, 5).map((tag) => el("span", { class: "search-result-tag" }, tag)),
  ]);

  const body = el("div", { class: "search-result-body" },
    snippet.length > 600 ? snippet.slice(0, 600) + "…" : snippet);

  const actions = el("div", { class: "search-result-actions" }, [
    path
      ? el("button", {
          class: "cv-btn",
          type: "button",
          title: path,
          onclick: () => { void copyPath(path); },
        }, t("search.actions.copy_path"))
      : null,
    path
      ? el("button", {
          class: "cv-btn",
          type: "button",
          onclick: () => { void openInLibrary(path); },
        }, t("search.actions.open_in_library"))
      : null,
  ]);

  return el("article", { class: "search-result" }, [head, meta, body, actions]);
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
  } catch (err) {
    console.warn("[search] clipboard write failed:", err);
    await showAlert(t("search.actions.copy_failed"));
  }
}

async function openInLibrary(path) {
  /* Найти книгу в каталоге по точному совпадению originalFile. Это самый
     дешёвый путь без нового IPC: catalog уже умеет фильтровать по search. */
  try {
    const res = await window.api.library.catalog({
      search: extractFileName(path),
      limit: 5,
    });
    const match = res?.rows?.find((r) => r.originalFile === path);
    if (match) {
      window.location.hash = `#book/${match.id}`;
      return;
    }
  } catch (err) {
    console.warn("[search] openInLibrary lookup failed:", err);
  }
  await copyPath(path);
}

function extractFileName(p) {
  if (!p) return "";
  const sepIdx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return sepIdx >= 0 ? p.slice(sepIdx + 1) : p;
}

function pickStr(obj, keys) {
  for (const key of keys) {
    const v = /** @type {any} */ (obj)[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
