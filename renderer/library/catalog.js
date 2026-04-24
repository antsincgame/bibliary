// @ts-check
/**
 * Catalog tab: table, toolbar, bottom-bar, inline-toast.
 */
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { CATALOG } from "./state.js";
import { filterCatalog as filterCatalogPure, qualityClass, statusClass, QUALITY_PRESETS } from "./catalog-filter.js";
import { fmtWords, fmtQuality } from "./format.js";
import { guardAndCrystallize, cancelBatchExtraction, launchSynthesis } from "./batch-actions.js";

function filterCatalog(rows) {
  return filterCatalogPure(rows, CATALOG.filters);
}

function statusLabel(status) {
  const key = `library.catalog.status.${status}`;
  const trans = t(key);
  return trans === key ? status : trans;
}

export async function loadCatalog() {
  if (CATALOG.loading) return;
  CATALOG.loading = true;
  try {
    const res = await window.api.library.catalog({ limit: 5000 });
    CATALOG.rows = /** @type {import("./state.js").CatalogMeta[]} */ (res.rows || []);
    CATALOG.total = res.total ?? CATALOG.rows.length;
  } catch (err) {
    console.error("[library.catalog] load failed:", err);
    CATALOG.rows = [];
    CATALOG.total = 0;
  } finally {
    CATALOG.loading = false;
  }
}

export function renderCatalogTable(root) {
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

  for (const row of filtered) {
    const cb = el("input", { type: "checkbox", class: "lib-catalog-cb" });
    cb.checked = CATALOG.selected.has(row.id);
    cb.addEventListener("change", () => {
      if (cb.checked) CATALOG.selected.add(row.id);
      else CATALOG.selected.delete(row.id);
      const sEl = root.querySelector(".lib-catalog-summary-selected");
      if (sEl) sEl.textContent = t("library.catalog.summary.selected", { n: String(CATALOG.selected.size) });
    });
    const q = typeof row.qualityScore === "number" ? row.qualityScore : null;
    const tr = el("tr", {
      class: `lib-catalog-row ${statusClass(row.status)} ${q !== null ? qualityClass(q) : ""}`,
      "data-book-id": row.id,
    }, [
      el("td", { class: "lib-catalog-cell-cb" }, [cb]),
      el("td", { class: "lib-catalog-cell-title", title: row.id }, row.title || row.id),
      el("td", { class: "lib-catalog-cell-author" }, row.author || ""),
      el("td", { class: "lib-catalog-cell-domain" }, row.domain || ""),
      el("td", { class: "lib-catalog-cell-words" }, fmtWords(row.wordCount)),
      el("td", { class: "lib-catalog-cell-quality" }, q !== null ? fmtQuality(q) : ""),
      el("td", { class: "lib-catalog-cell-status" }, statusLabel(row.status)),
    ]);
    tbody.appendChild(tr);
  }
}

/** @param {HTMLElement} root */
export async function renderCatalog(root) {
  await loadCatalog();
  renderCatalogTable(root);
}

/** @param {HTMLElement} root */
export function buildCatalogToolbar(root) {
  /* Компактный однострочный toolbar: search занимает основную ширину,
     остальные контролы (Quality, Hide fiction, presets, refresh, rebuild)
     прижаты вправо. На узком экране переносится через flex-wrap. */
  const searchInput = el("input", {
    type: "text", class: "lib-catalog-search",
    placeholder: t("library.catalog.filter.search.placeholder"),
    title: t("library.catalog.filter.search"),
    value: CATALOG.filters.search || "",
  });
  searchInput.addEventListener("input", () => {
    CATALOG.filters.search = /** @type {HTMLInputElement} */ (searchInput).value;
    renderCatalogTable(root);
  });

  const qualitySlider = /** @type {HTMLInputElement} */ (el("input", {
    type: "range", class: "lib-catalog-quality-slider",
    min: "0", max: "100", step: "5", value: String(CATALOG.filters.quality),
    title: t("library.catalog.filter.quality.label"),
  }));
  const qualityVal = el("span", { class: "lib-catalog-quality-val" },
    CATALOG.filters.quality > 0 ? `\u2265${CATALOG.filters.quality}` : t("library.catalog.filter.quality.any"),
  );
  qualitySlider.addEventListener("input", () => {
    const v = Number(qualitySlider.value);
    CATALOG.filters.quality = v;
    qualityVal.textContent = v > 0 ? `\u2265${v}` : t("library.catalog.filter.quality.any");
    syncPresetActive(presetWrap);
    renderCatalogTable(root);
  });

  const fictionCb = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox", class: "lib-catalog-fiction-cb",
    checked: CATALOG.filters.hideFiction ? "checked" : undefined,
  }));
  fictionCb.addEventListener("change", () => {
    CATALOG.filters.hideFiction = fictionCb.checked;
    renderCatalogTable(root);
  });

  const presetWrap = el("div", { class: "lib-catalog-presets" });
  for (const p of QUALITY_PRESETS) {
    const label = t(p.labelKey);
    const btn = el("button", {
      type: "button",
      class: "lib-btn lib-btn-ghost lib-catalog-preset",
      "data-quality": String(p.minQuality),
      "data-fiction": p.hideFiction ? "1" : "0",
      title: label,
      "aria-label": label,
      onclick: () => {
        CATALOG.filters.quality = p.minQuality;
        CATALOG.filters.hideFiction = p.hideFiction;
        qualitySlider.value = String(p.minQuality);
        qualityVal.textContent = p.minQuality > 0
          ? `\u2265${p.minQuality}`
          : t("library.catalog.filter.quality.any");
        fictionCb.checked = p.hideFiction;
        syncPresetActive(presetWrap);
        renderCatalogTable(root);
      },
    }, label);
    presetWrap.appendChild(btn);
  }
  syncPresetActive(presetWrap);

  const refreshBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    onclick: () => void renderCatalog(root),
  }, t("library.catalog.btn.refresh"));

  const rebuildBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    onclick: async () => {
      try {
        const res = await window.api.library.rebuildCache();
        window.alert(t("library.catalog.rebuild.done", {
          scanned: String(res.scanned),
          ingested: String(res.ingested),
          pruned: String(res.pruned),
        }));
      } catch (e) {
        window.alert(t("library.catalog.rebuild.failed", {
          error: e instanceof Error ? e.message : String(e),
        }));
      }
      void renderCatalog(root);
    },
  }, t("library.catalog.btn.rebuild"));

  return el("div", { class: "lib-catalog-toolbar lib-catalog-toolbar-compact" }, [
    searchInput,
    el("div", { class: "lib-catalog-quality-wrap" }, [
      el("label", { class: "lib-catalog-quality-label" }, t("library.catalog.filter.quality.label")),
      qualitySlider, qualityVal,
    ]),
    el("label", { class: "lib-catalog-fiction-label", title: t("library.catalog.filter.hideFiction") }, [
      fictionCb,
      el("span", { class: "lib-catalog-fiction-text" }, t("library.catalog.filter.hideFiction")),
    ]),
    presetWrap,
    refreshBtn, rebuildBtn,
  ]);
}

function syncPresetActive(presetWrap) {
  presetWrap.querySelectorAll(".lib-catalog-preset").forEach((btn) => {
    const q = Number(/** @type {HTMLElement} */ (btn).dataset.quality);
    const f = /** @type {HTMLElement} */ (btn).dataset.fiction === "1";
    btn.classList.toggle("lib-catalog-preset-active", q === CATALOG.filters.quality && f === CATALOG.filters.hideFiction);
  });
}

export function buildCatalogTable() {
  const thead = el("thead", {}, [
    el("tr", {}, [
      el("th", { class: "lib-catalog-th-cb" }),
      el("th", {}, t("library.catalog.col.title")),
      el("th", {}, t("library.catalog.col.author")),
      el("th", {}, t("library.catalog.col.domain")),
      el("th", {}, t("library.catalog.col.words")),
      el("th", {}, t("library.catalog.col.quality")),
      el("th", {}, t("library.catalog.col.status")),
    ]),
  ]);
  const tbody = el("tbody", { class: "lib-catalog-tbody" });
  return el("div", { class: "lib-catalog-table-wrap" }, [
    el("table", { class: "lib-catalog-table" }, [thead, tbody]),
  ]);
}

/**
 * @param {HTMLElement} root
 * @param {object} deps
 * @param {(root: HTMLElement) => Promise<void>} deps.renderCatalog
 * @param {(root: HTMLElement) => void} deps.renderCatalogTable
 */
export function buildCatalogBottomBar(root, deps) {
  const summary = el("div", { class: "lib-catalog-summary" }, [
    el("span", { class: "lib-catalog-summary-shown" }, t("library.catalog.summary.shown", { shown: "0", total: "0" })),
    el("span", { class: "lib-catalog-summary-sep" }, "\u00b7"),
    el("span", { class: "lib-catalog-summary-selected" }, t("library.catalog.summary.selected", { n: "0" })),
  ]);

  const selectAllBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    onclick: () => {
      const filtered = filterCatalog(CATALOG.rows);
      for (const r of filtered) CATALOG.selected.add(r.id);
      deps.renderCatalogTable(root);
    },
  }, t("library.catalog.btn.selectAll"));

  const clearBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    onclick: () => {
      CATALOG.selected.clear();
      deps.renderCatalogTable(root);
    },
  }, t("library.catalog.btn.clearSel"));

  const deleteBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-danger",
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
      await deps.renderCatalog(root);
    },
  }, t("library.catalog.btn.delete"));

  const prioritizeBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    title: t("library.catalog.tooltip.prioritize"),
    onclick: async () => {
      if (CATALOG.selected.size === 0) return;
      const ids = Array.from(CATALOG.selected);
      try {
        const r = /** @type {any} */ (await window.api.library.evaluatorPrioritize(ids));
        setCatalogStatus(root, t("library.catalog.toast.prioritized", {
          n: String(r?.queued ?? ids.length),
        }));
      } catch (e) { console.warn("[library.prioritize]", e); }
    },
  }, t("library.catalog.btn.prioritize"));

  const reevaluateBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    title: t("library.catalog.tooltip.reevaluate"),
    onclick: async () => {
      if (CATALOG.selected.size === 0) return;
      const ids = Array.from(CATALOG.selected);
      let queued = 0;
      for (const bookId of ids) {
        try {
          const r = /** @type {any} */ (await window.api.library.reevaluate(bookId));
          if (r?.ok) queued += 1;
        } catch (e) { console.warn("[library.reevaluate]", bookId, e); }
      }
      setCatalogStatus(root, t("library.catalog.toast.reevaluated", { n: String(queued) }));
      await deps.renderCatalog(root);
    },
  }, t("library.catalog.btn.reevaluate"));

  const crystallizeBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-primary",
    onclick: () => guardAndCrystallize(root, deps),
  }, t("library.catalog.btn.crystallize"));

  const synthesizeBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-secondary",
    onclick: () => void launchSynthesis(),
  }, t("library.catalog.btn.synthesize"));

  const cancelBatchBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-danger lib-btn-cancel-batch",
    style: "display:none",
    onclick: () => void cancelBatchExtraction(),
  }, t("library.catalog.btn.cancelBatch"));

  const batchSummary = el("span", { class: "lib-catalog-batch-summary" }, "");

  return el("div", { class: "lib-catalog-bottombar" }, [
    summary,
    el("div", { class: "lib-catalog-actions" }, [
      selectAllBtn, clearBtn, prioritizeBtn, reevaluateBtn, deleteBtn, synthesizeBtn, crystallizeBtn, cancelBatchBtn,
    ]),
    batchSummary,
  ]);
}

/** @param {HTMLElement} root */
export function buildCatalogPane(root, deps) {
  const toolbar = buildCatalogToolbar(root);
  const table = buildCatalogTable();
  const bottombar = buildCatalogBottomBar(root, deps);
  const body = el("div", { class: "lib-catalog-body" }, [toolbar, table, bottombar]);
  return el("div", { class: "lib-pane lib-pane-catalog lib-pane-active" }, [body]);
}

function setCatalogStatus(root, text) {
  if (!root) return;
  const statusEl = root.querySelector(".lib-catalog-batch-summary");
  if (!statusEl) return;
  statusEl.textContent = text;
  if (/** @type {HTMLElement} */ (statusEl).dataset.clearTimer) {
    clearTimeout(Number(/** @type {HTMLElement} */ (statusEl).dataset.clearTimer));
  }
  const timer = window.setTimeout(() => {
    if (statusEl.textContent === text) statusEl.textContent = "";
    delete /** @type {HTMLElement} */ (statusEl).dataset.clearTimer;
  }, 4000);
  /** @type {HTMLElement} */ (statusEl).dataset.clearTimer = String(timer);
}
