// @ts-check
/**
 * Δ-ui-b — graph-aware chunk search panel.
 *
 * Uses GET /api/datasets/search-chunks: cosine over L1 chunk embeddings
 * blended with Personalized PageRank seeded from query tokens. UI is
 * intentionally minimal — one input, two sliders (α/β), one results
 * list with breadcrumb + scores. Nothing about it requires a layout
 * rewrite; lifted into a separate module to keep datasets.js readable.
 */

import { el, clear } from "./dom.js";

/** @typedef {{
 *   chunkRowid: number,
 *   bookId: string,
 *   similarity: number,
 *   graphScore: number,
 *   finalScore: number,
 *   level: number,
 *   pathTitles: string[],
 *   partN: number | null,
 *   partOf: number | null,
 *   text: string,
 * }} ChunkHit */

const STATE = {
  q: "",
  alpha: 0.7,
  beta: 0.3,
  loading: false,
  /** @type {ChunkHit[]} */ rows: [],
  /** @type {string | null} */ error: null,
  pprSeeds: 0,
  pprIterations: 0,
};

function fmtScore(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(3);
}

function fmtPath(crumbs) {
  if (!Array.isArray(crumbs) || crumbs.length === 0) return "(no breadcrumb)";
  return crumbs.join(" › ");
}

function truncate(text, n) {
  const s = String(text ?? "");
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/**
 * @param {HTMLElement} container
 */
function renderResults(container) {
  clear(container);
  if (STATE.loading) {
    container.append(el("div", { class: "ds-search-empty" }, "Searching…"));
    return;
  }
  if (STATE.error) {
    container.append(
      el("div", { class: "ds-search-empty ds-search-error" }, `Error: ${STATE.error}`),
    );
    return;
  }
  if (STATE.rows.length === 0 && STATE.q.length >= 2) {
    container.append(
      el("div", { class: "ds-search-empty" }, "No matching chunks. Try lowering minSimilarity or crystallizing more books."),
    );
    return;
  }
  if (STATE.rows.length === 0) {
    container.append(
      el("div", { class: "ds-search-empty" }, "Type a query above to search chunks across all crystallized books."),
    );
    return;
  }
  if (STATE.pprSeeds > 0) {
    container.append(
      el("div", { class: "ds-search-status" },
        `PPR: ${STATE.pprSeeds} seed entities, ${STATE.pprIterations} iterations`,
      ),
    );
  }
  for (const r of STATE.rows) {
    const breadcrumb = el(
      "div",
      { class: "ds-chunk-breadcrumb", title: fmtPath(r.pathTitles) },
      fmtPath(r.pathTitles),
    );
    const meta = el("div", { class: "ds-chunk-meta" }, [
      el("span", { class: "ds-chunk-score" }, `final ${fmtScore(r.finalScore)}`),
      el("span", { class: "ds-chunk-score-sub" }, `cosine ${fmtScore(r.similarity)}`),
      el("span", { class: "ds-chunk-score-sub" }, `graph ${fmtScore(r.graphScore)}`),
      r.partN != null && r.partOf != null
        ? el("span", { class: "ds-chunk-part" }, `part ${r.partN}/${r.partOf}`)
        : null,
      el("span", { class: "ds-chunk-book", title: r.bookId },
        `book ${r.bookId.slice(0, 8)}…`,
      ),
    ].filter(Boolean));
    const text = el("div", { class: "ds-chunk-text" }, truncate(r.text, 600));
    container.append(el("article", { class: "ds-chunk-hit" }, [breadcrumb, meta, text]));
  }
}

let debounceTimer = null;

/**
 * @param {HTMLElement} container
 */
async function doSearch(container) {
  if (STATE.q.trim().length < 2) {
    STATE.rows = [];
    STATE.error = null;
    STATE.pprSeeds = 0;
    STATE.pprIterations = 0;
    renderResults(container);
    return;
  }
  STATE.loading = true;
  STATE.error = null;
  renderResults(container);
  try {
    const res = /** @type {any} */ (
      await window.api.datasets.searchChunks({
        q: STATE.q,
        alpha: STATE.alpha,
        beta: STATE.beta,
        limit: 15,
      })
    );
    STATE.rows = Array.isArray(res?.rows) ? res.rows : [];
    STATE.pprSeeds = typeof res?.pprSeeds === "number" ? res.pprSeeds : 0;
    STATE.pprIterations = typeof res?.pprIterations === "number" ? res.pprIterations : 0;
  } catch (err) {
    STATE.rows = [];
    STATE.error = err instanceof Error ? err.message : String(err);
  } finally {
    STATE.loading = false;
    renderResults(container);
  }
}

/**
 * @param {HTMLElement} container
 */
function scheduleSearch(container) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void doSearch(container);
  }, 250);
}

/**
 * Build and return the search panel root element. Caller appends to
 * the page. Idempotent: re-mount is safe because we own all DOM under
 * the returned root.
 *
 * @returns {HTMLElement}
 */
export function buildSearchChunksPanel() {
  const resultsBox = el("div", { class: "ds-search-results" });

  const input = el("input", {
    type: "search",
    class: "ds-search-input",
    placeholder: "Search across crystallized books (e.g. FEM convergence)…",
    value: STATE.q,
    autocomplete: "off",
    oninput: (ev) => {
      STATE.q = /** @type {HTMLInputElement} */ (ev.target).value;
      scheduleSearch(resultsBox);
    },
  });

  const alphaSlider = el("input", {
    type: "range",
    min: "0",
    max: "1",
    step: "0.05",
    value: String(STATE.alpha),
    class: "ds-search-slider",
    oninput: (ev) => {
      STATE.alpha = Number(/** @type {HTMLInputElement} */ (ev.target).value);
      alphaLabel.textContent = `α = ${STATE.alpha.toFixed(2)}`;
      scheduleSearch(resultsBox);
    },
  });
  const alphaLabel = el(
    "label",
    { class: "ds-search-slider-label" },
    `α = ${STATE.alpha.toFixed(2)}`,
  );

  const betaSlider = el("input", {
    type: "range",
    min: "0",
    max: "1",
    step: "0.05",
    value: String(STATE.beta),
    class: "ds-search-slider",
    oninput: (ev) => {
      STATE.beta = Number(/** @type {HTMLInputElement} */ (ev.target).value);
      betaLabel.textContent = `β = ${STATE.beta.toFixed(2)}`;
      scheduleSearch(resultsBox);
    },
  });
  const betaLabel = el(
    "label",
    { class: "ds-search-slider-label" },
    `β = ${STATE.beta.toFixed(2)}`,
  );

  const explainer = el(
    "div",
    { class: "ds-search-hint" },
    "α weights cosine similarity, β weights graph-PPR. β=0 → pure semantic. " +
      "Set α=0 to see what the graph alone returns.",
  );

  const controls = el("div", { class: "ds-search-controls" }, [
    input,
    el("div", { class: "ds-search-sliders" }, [
      el("div", { class: "ds-search-slider-row" }, [alphaLabel, alphaSlider]),
      el("div", { class: "ds-search-slider-row" }, [betaLabel, betaSlider]),
    ]),
  ]);

  renderResults(resultsBox);

  return el("section", { class: "ds-search-panel" }, [
    el("h2", { class: "ds-search-title" }, "Graph-aware chunk search"),
    explainer,
    controls,
    resultsBox,
  ]);
}
