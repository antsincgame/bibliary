// @ts-check
/**
 * Catalog tab: table, toolbar, bottom-bar, inline-toast.
 */
import { el, clear } from "../dom.js";
import { t, getLocale } from "../i18n.js";
import { showAlert, showConfirm } from "../components/ui-dialog.js";
import { CATALOG } from "./state.js";
import { filterCatalog as filterCatalogPure, qualityClass, statusClass } from "./catalog-filter.js";
import { fmtWords, fmtQuality } from "./format.js";
import { guardAndCrystallize } from "./batch-actions.js";
import { openBook } from "./reader.js";
import { openTagCloudModal } from "./tag-cloud.js";
import { displayBookTitle, displayBookAuthor, bookTitleTooltip } from "./display-meta.js";

/** @type {Promise<void> | null} */
let catalogLoadPromise = null;

const CATALOG_PAGE_SIZE = 100;

/** @type {ReturnType<typeof setTimeout> | null} */
let debounceTimer = null;

function filterCatalog(rows) {
  return filterCatalogPure(rows, CATALOG.filters);
}

function debouncedRender(root, delayMs = 200) {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    renderCatalogTable(root);
  }, delayMs);
}

function statusLabel(status) {
  const key = `library.catalog.status.${status}`;
  const trans = t(key);
  return trans === key ? status : trans;
}

/** @param {string | undefined} value */
function compactError(value) {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 96);
}

/** @param {unknown} err */
function catalogErrMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

export async function loadCatalog() {
  if (catalogLoadPromise) {
    await catalogLoadPromise;
    return;
  }
  CATALOG.loading = true;
  catalogLoadPromise = (async () => {
    try {
      const res = await window.api.library.catalog({
        limit: CATALOG_PAGE_SIZE,
        offset: 0,
        displayLocale: getLocale() === "ru" ? "ru" : "en",
      });
      CATALOG.rows = /** @type {import("./state.js").CatalogMeta[]} */ (res.rows || []);
      CATALOG.total = res.total ?? CATALOG.rows.length;
      CATALOG.libraryRoot = res.libraryRoot || "";
      CATALOG.dbPath = res.dbPath || "";
    } catch (err) {
      console.error("[library.catalog] load failed:", err);
      CATALOG.rows = [];
      CATALOG.total = 0;
      await showAlert(t("library.catalog.loadError", { msg: compactError(catalogErrMsg(err)) }));
    } finally {
      CATALOG.loading = false;
      catalogLoadPromise = null;
    }
  })();
  await catalogLoadPromise;
}

/**
 * @param {HTMLElement | null} [root] When set, table + «Load more» label refresh after error.
 */
export async function loadMoreCatalog(root = null) {
  if (CATALOG.loading || CATALOG.rows.length >= CATALOG.total) return;
  CATALOG.loading = true;
  try {
    const res = await window.api.library.catalog({
      limit: CATALOG_PAGE_SIZE,
      offset: CATALOG.rows.length,
      displayLocale: getLocale() === "ru" ? "ru" : "en",
    });
    const newRows = /** @type {import("./state.js").CatalogMeta[]} */ (res.rows || []);
    CATALOG.rows.push(...newRows);
    CATALOG.total = res.total ?? CATALOG.total;
  } catch (err) {
    console.error("[library.catalog] loadMore failed:", err);
    await showAlert(t("library.catalog.loadMoreError", { msg: compactError(catalogErrMsg(err)) }));
    if (root) renderCatalogTable(root);
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
  const capEl = root.querySelector(".lib-catalog-summary-cap");
  if (capEl) capEl.textContent = CATALOG.rows.length < CATALOG.total
    ? t("library.catalog.summary.partial", {
      loaded: String(CATALOG.rows.length),
      total: String(CATALOG.total),
    })
    : "";

  if (filtered.length === 0) {
    const msg = CATALOG.rows.length === 0
      ? `${t("library.catalog.empty.title")} — ${t("library.catalog.empty.body")}`
      : t("library.catalog.empty.filtered");
    tbody.appendChild(el("tr", { class: "lib-catalog-empty-row" }, [
      el("td", { colspan: "8", class: "lib-empty-cell" }, msg),
    ]));
    updateLoadMoreButton(root);
    return;
  }

  const visible = filtered.slice(0, CATALOG_PAGE_SIZE * 2);
  for (const row of visible) {
    const cb = el("input", { type: "checkbox", class: "lib-catalog-cb" });
    cb.checked = CATALOG.selected.has(row.id);
    cb.addEventListener("change", () => {
      if (cb.checked) CATALOG.selected.add(row.id);
      else CATALOG.selected.delete(row.id);
      const sEl = root.querySelector(".lib-catalog-summary-selected");
      if (sEl) sEl.textContent = t("library.catalog.summary.selected", { n: String(CATALOG.selected.size) });
    });
    const q = typeof row.qualityScore === "number" ? row.qualityScore : null;
    /* Title / author: locale-aware зеркала (display-meta). */
    const displayTitle = displayBookTitle(row);
    const titleCell = el("td", {
      class: "lib-catalog-cell-title lib-catalog-cell-clickable",
      title: bookTitleTooltip(row),
      onclick: () => {
        const pane = root.closest(".lib-pane-catalog") || root;
        openBook(row.id, pane);
      },
    }, displayTitle);
    const displayAuthor = displayBookAuthor(row);
    const statusText = statusLabel(row.status);
    const errorText = compactError(row.lastError);
    const statusCell = el("td", {
      class: "lib-catalog-cell-status",
      title: errorText || statusText,
    }, errorText && row.status === "failed" ? `${statusText}: ${errorText}` : statusText);

    const tr = el("tr", {
      class: `lib-catalog-row ${statusClass(row.status)} ${q !== null ? qualityClass(q) : ""}`,
      "data-book-id": row.id,
    }, [
      el("td", { class: "lib-catalog-cell-cb" }, [cb]),
      titleCell,
      el("td", { class: "lib-catalog-cell-author" }, displayAuthor),
      el("td", { class: "lib-catalog-cell-year" }, row.year ? String(row.year) : ""),
      el("td", { class: "lib-catalog-cell-domain" }, row.domain || ""),
      el("td", { class: "lib-catalog-cell-words" }, fmtWords(row.wordCount)),
      el("td", { class: "lib-catalog-cell-quality" }, q !== null ? fmtQuality(q) : ""),
      statusCell,
    ]);
    tbody.appendChild(tr);
  }
  updateLoadMoreButton(root);
}

function updateLoadMoreButton(root) {
  let btn = root.querySelector(".lib-catalog-load-more");
  const hasMore = CATALOG.rows.length < CATALOG.total;
  if (!hasMore) {
    if (btn) btn.remove();
    return;
  }
  if (!btn) {
    btn = el("button", {
      type: "button",
      class: "lib-btn lib-btn-ghost lib-catalog-load-more",
      title: t("library.catalog.tooltip.loadMore"),
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = "...";
        await loadMoreCatalog(root);
        renderCatalogTable(root);
        btn.disabled = false;
      },
    });
    const tableWrap = root.querySelector(".lib-catalog-table-wrap");
    if (tableWrap) tableWrap.appendChild(btn);
  }
  btn.textContent = t("library.catalog.btn.loadMore") || `\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0435\u0449\u0451 (${CATALOG.rows.length}/${CATALOG.total})`;
}

/** @param {HTMLElement} root */
export async function renderCatalog(root) {
  await loadCatalog();
  renderCatalogTable(root);
}

/**
 * Scroll and highlight a catalog row by bookId.
 * @param {HTMLElement} root
 * @param {string} bookId
 */
export function highlightCatalogBookRow(root, bookId) {
  if (!bookId) return;
  const esc = typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(bookId)
    : bookId.replace(/["\\]/g, "\\$&");
  const row = /** @type {HTMLElement|null} */ (root.querySelector(`.lib-catalog-row[data-book-id="${esc}"]`));
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("lib-catalog-row-focus");
  setTimeout(() => row.classList.remove("lib-catalog-row-focus"), 2600);
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
    debouncedRender(root, 300);
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
    debouncedRender(root, 150);
  });

  const tagCloudBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    title: t("library.catalog.tooltip.tagCloud"),
    onclick: () => void openTagCloudModal({ root, renderCatalogTable }),
  }, t("library.catalog.btn.tagCloud"));

  return el("div", { class: "lib-catalog-toolbar lib-catalog-toolbar-compact" }, [
    searchInput,
    tagCloudBtn,
    el("div", { class: "lib-catalog-quality-wrap" }, [
      el("label", { class: "lib-catalog-quality-label" }, t("library.catalog.filter.quality.label")),
      qualitySlider, qualityVal,
    ]),
  ]);
}


export function buildCatalogTable() {
  const thead = el("thead", {}, [
    el("tr", {}, [
      el("th", { class: "lib-catalog-th-cb" }),
      el("th", {}, t("library.catalog.col.title")),
      el("th", {}, t("library.catalog.col.author")),
      el("th", { class: "lib-catalog-th-year" }, t("library.catalog.col.year")),
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
  const metaRow = el("div", { class: "lib-catalog-dock-meta" }, [
    el("span", { class: "lib-catalog-summary-shown" }, t("library.catalog.summary.shown", { shown: "0", total: "0" })),
    el("span", { class: "lib-catalog-summary-sep" }, "\u00b7"),
    el("span", { class: "lib-catalog-summary-selected" }, t("library.catalog.summary.selected", { n: "0" })),
    el("span", { class: "lib-catalog-summary-cap" }, ""),
  ]);

  const selectAllBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    title: t("library.catalog.tooltip.selectAll"),
    onclick: () => {
      const filtered = filterCatalog(CATALOG.rows);
      for (const r of filtered) CATALOG.selected.add(r.id);
      deps.renderCatalogTable(root);
    },
  }, t("library.catalog.btn.selectAll"));

  const clearBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    title: t("library.catalog.tooltip.clearSelection"),
    onclick: () => {
      CATALOG.selected.clear();
      deps.renderCatalogTable(root);
    },
  }, t("library.catalog.btn.clearSel"));

  const deleteBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-danger",
    title: t("library.catalog.tooltip.delete"),
    onclick: (ev) => void withButtonBusy(ev, async () => {
      if (CATALOG.selected.size === 0) {
        setCatalogStatus(root, t("library.catalog.toast.nothingSelected"));
        return;
      }
      if (!(await showConfirm(t("library.catalog.confirm.delete", {
        n: String(CATALOG.selected.size),
      }), {
        title: t("library.catalog.confirm.deleteTitle"),
        okText: t("library.catalog.btn.delete"),
        okVariant: "danger",
      }))) return;
      const deleteErrors = /** @type {string[]} */ ([]);
      let deleteOk = 0;
      for (const bookId of Array.from(CATALOG.selected)) {
        try {
          await window.api.library.deleteBook(bookId, true);
          deleteOk += 1;
        } catch (e) {
          console.warn("[library.delete]", bookId, e);
          deleteErrors.push(`${bookId.slice(0, 8)}…: ${compactError(catalogErrMsg(e))}`);
        }
      }
      CATALOG.selected.clear();
      await deps.renderCatalog(root);
      if (deleteErrors.length > 0) {
        const detail = deleteErrors.slice(0, 5).join("\n");
        await showAlert(t("library.catalog.delete.partialFailed", {
          ok: String(deleteOk),
          fail: String(deleteErrors.length),
          detail,
        }));
      }
    }),
  }, t("library.catalog.btn.delete"));

  const reevaluateBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    "data-mode-min": "advanced",
    title: t("library.catalog.tooltip.reevaluate"),
    onclick: (ev) => void withButtonBusy(ev, async () => {
      if (CATALOG.selected.size === 0) {
        setCatalogStatus(root, t("library.catalog.toast.nothingSelected"));
        return;
      }
      if (!(await showConfirm(t("library.catalog.confirm.reevaluate", {
        n: String(CATALOG.selected.size),
      }), {
        title: t("library.catalog.confirm.reevaluateTitle"),
        okText: t("library.catalog.btn.reevaluate"),
      }))) return;
      const ids = Array.from(CATALOG.selected);
      let queued = 0;
      const reevalErrors = /** @type {string[]} */ ([]);
      for (const bookId of ids) {
        try {
          const r = /** @type {any} */ (await window.api.library.reevaluate(bookId));
          if (r?.ok) queued += 1;
          else reevalErrors.push(`${bookId.slice(0, 8)}…: ${compactError(r?.reason || "not ok")}`);
        } catch (e) {
          console.warn("[library.reevaluate]", bookId, e);
          reevalErrors.push(`${bookId.slice(0, 8)}…: ${compactError(catalogErrMsg(e))}`);
        }
      }
      const failed = ids.length - queued;
      if (failed > 0) {
        setCatalogStatus(root, t("library.catalog.toast.reevaluatedWithErrors", {
          ok: String(queued),
          fail: String(failed),
        }));
        const detail = reevalErrors.slice(0, 5).join("\n");
        await showAlert(t("library.catalog.reevaluate.partialFailed", {
          ok: String(queued),
          fail: String(failed),
          detail,
        }));
      } else {
        setCatalogStatus(root, t("library.catalog.toast.reevaluated", { n: String(queued) }));
      }
      await deps.renderCatalog(root);
    }),
  }, t("library.catalog.btn.reevaluate"));

  deleteBtn.dataset.modeMin = "pro";

  const reparseBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-ghost",
    "data-mode-min": "advanced",
    title: t("library.catalog.tooltip.reparse"),
    onclick: (ev) => void withButtonBusy(ev, async () => {
      /* Если ничего не выбрано — переparsим ВСЕ unsupported. */
      const targets = CATALOG.selected.size > 0
        ? CATALOG.rows.filter((r) => CATALOG.selected.has(r.id) && r.status === "unsupported")
        : CATALOG.rows.filter((r) => r.status === "unsupported");

      if (targets.length === 0) {
        await showAlert(t("library.catalog.reparse.nothingToDo"));
        return;
      }

      if (!(await showConfirm(t("library.catalog.confirm.reparse", {
        n: String(targets.length),
      }), {
        title: t("library.catalog.confirm.reparseTitle"),
        okText: t("library.catalog.btn.reparse"),
      }))) return;

      let ok = 0;
      let fail = 0;
      const errors = /** @type {string[]} */ ([]);
      setCatalogStatus(root, t("library.catalog.reparse.running", { n: String(targets.length) }));

      for (const row of targets) {
        try {
          const res = await window.api.library.reparseBook(row.id);
          if (res?.ok) {
            ok++;
            const idx = CATALOG.rows.findIndex((r) => r.id === row.id);
            if (idx >= 0) CATALOG.rows[idx].status = "imported";
          } else {
            fail++;
            if (res?.reason) errors.push(`${row.title?.slice(0, 40)}: ${res.reason}`);
          }
        } catch (e) {
          fail++;
          errors.push(`${row.title?.slice(0, 40)}: ${e instanceof Error ? e.message : String(e)}`);
        }
        deps.renderCatalogTable(root);
      }

      const summary = t("library.catalog.reparse.done", { ok: String(ok), fail: String(fail) });
      const detail = errors.slice(0, 3).join("\n");
      await showAlert(detail ? `${summary}\n\n${detail}` : summary);
      await deps.renderCatalog(root);
    }),
  }, t("library.catalog.btn.reparse"));

  const chunksBtn = el("button", {
    type: "button", class: "lib-btn lib-btn-primary",
    title: t("library.catalog.tooltip.createChunks"),
    onclick: () => void guardAndCrystallize(root, deps),
  }, t("library.catalog.btn.createChunks"));

  const batchSummary = el("span", { class: "lib-catalog-batch-summary" }, "");

  return el("div", { class: "lib-catalog-bottombar" }, [
    metaRow,
    el("div", { class: "lib-catalog-bottom-actions" }, [
      selectAllBtn, clearBtn, reevaluateBtn, reparseBtn, deleteBtn, chunksBtn,
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

/**
 * Prevent duplicate async actions from double-clicks while preserving the
 * existing button layout and handlers.
 * @param {Event|HTMLButtonElement} evOrButton
 * @param {() => Promise<void>} task
 */
async function withButtonBusy(evOrButton, task) {
  const btn = evOrButton instanceof HTMLButtonElement
    ? evOrButton
    : evOrButton.currentTarget instanceof HTMLButtonElement
      ? evOrButton.currentTarget
      : null;
  if (btn?.disabled) return;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("lib-btn-busy");
  }
  try {
    await task();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("lib-btn-busy");
    }
  }
}
