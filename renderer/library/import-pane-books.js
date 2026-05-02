// @ts-check
/**
 * Books-in-flight panel: per-book status cards.
 *
 * Источники данных: IMPORT_STATE.inFlight (заполняется в import-pane-actions.js
 * через onImportProgress). Здесь только визуализация.
 *
 * Производительность: рендерим max 100 карточек одновременно (top-100 last
 * activity). Остальное идёт в счётчики status bar. Идиома идемпотентна —
 * полный rerender карточек при каждом event приемлем при N≤100.
 */

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { IMPORT_STATE } from "./state.js";

const MAX_VISIBLE_CARDS = 100;
let BOOKS_PANEL_REF = null;

/**
 * Идемпотентный singleton — повторный mount возвращает existing panel.
 * @returns {HTMLElement}
 */
export function buildBooksPanel() {
  if (BOOKS_PANEL_REF) return BOOKS_PANEL_REF;

  const counterProcessing = el("span", {
    class: "lib-import-log-counter lib-import-books-counter-processing",
    title: t("library.import.books.counter.processing"),
  }, "0");
  const counterAdded = el("span", {
    class: "lib-import-log-counter lib-import-books-counter-added",
    title: t("library.import.books.counter.added"),
  }, "0");
  const counterFailed = el("span", {
    class: "lib-import-log-counter lib-import-books-counter-failed",
    title: t("library.import.books.counter.failed"),
  }, "0");
  const counterSkipped = el("span", {
    class: "lib-import-log-counter lib-import-books-counter-skipped",
    title: t("library.import.books.counter.skipped"),
  }, "0");
  const counterDup = el("span", {
    class: "lib-import-log-counter lib-import-books-counter-dup",
    title: t("library.import.books.counter.duplicate"),
  }, "0");

  const header = el("div", { class: "lib-import-log-header lib-import-books-header" }, [
    el("span", { class: "lib-import-log-title" }, t("library.import.books.title")),
    counterProcessing, counterAdded, counterFailed, counterSkipped, counterDup,
    el("span", { class: "lib-import-log-spacer" }),
  ]);

  const list = el("div", { class: "lib-import-books-list", role: "list" });
  const empty = el("div", { class: "lib-import-books-empty" }, t("library.import.books.empty"));

  const panel = el("div", { class: "lib-import-books-panel" }, [header, list, empty]);
  /** @type {any} */ (panel)._list = list;
  /** @type {any} */ (panel)._empty = empty;
  /** @type {any} */ (panel)._counterProcessing = counterProcessing;
  /** @type {any} */ (panel)._counterAdded = counterAdded;
  /** @type {any} */ (panel)._counterFailed = counterFailed;
  /** @type {any} */ (panel)._counterSkipped = counterSkipped;
  /** @type {any} */ (panel)._counterDup = counterDup;

  BOOKS_PANEL_REF = panel;
  return panel;
}

/**
 * Rerender per-book card grid based on IMPORT_STATE.inFlight.
 * Called by import-pane-actions.js on every progress event.
 */
export function rerenderBooksPanel() {
  if (!BOOKS_PANEL_REF) return;
  const p = /** @type {any} */ (BOOKS_PANEL_REF);
  const list = /** @type {HTMLElement} */ (p._list);
  const empty = /** @type {HTMLElement} */ (p._empty);
  if (!list || !empty) return;

  /* Обновляем счётчики из aggregate. */
  const agg = IMPORT_STATE.aggregate;
  const entries = Array.from(IMPORT_STATE.inFlight.values());
  const processingCount = entries.filter((e) => e.status === "processing").length;
  if (p._counterProcessing) p._counterProcessing.textContent = String(processingCount);
  if (p._counterAdded) p._counterAdded.textContent = String(agg.added ?? 0);
  if (p._counterFailed) p._counterFailed.textContent = String(agg.failed ?? 0);
  if (p._counterSkipped) p._counterSkipped.textContent = String(agg.skipped ?? 0);
  if (p._counterDup) p._counterDup.textContent = String(agg.duplicate ?? 0);

  if (entries.length === 0) {
    clear(list);
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  /* Сортировка: сначала processing, потом recent finished по startedAt desc.
     Top-100 — для безопасности рендера при импорте 5000+ файлов. */
  entries.sort((a, b) => {
    const aActive = a.status === "processing" ? 1 : 0;
    const bActive = b.status === "processing" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    const aTs = a.finishedAt ?? a.startedAt;
    const bTs = b.finishedAt ?? b.startedAt;
    return bTs - aTs;
  });
  const visible = entries.slice(0, MAX_VISIBLE_CARDS);

  clear(list);
  for (const bp of visible) {
    list.appendChild(buildCard(bp));
  }

  if (entries.length > MAX_VISIBLE_CARDS) {
    const more = el("div", { class: "lib-import-books-more" },
      t("library.import.books.more", { hidden: String(entries.length - MAX_VISIBLE_CARDS) }));
    list.appendChild(more);
  }
}

/** @param {import("./state.js").BookProgress} bp */
function buildCard(bp) {
  const cls = `lib-import-book-card lib-import-book-${bp.status}`;
  const statusLabel = t(`library.import.books.status.${bp.status}`);
  const elapsed = bp.finishedAt
    ? Math.max(0, bp.finishedAt - bp.startedAt)
    : Math.max(0, Date.now() - bp.startedAt);

  const meta = el("div", { class: "lib-import-book-meta" }, [
    el("span", { class: "lib-import-book-status" }, statusLabel),
    el("span", { class: "lib-import-book-time" }, formatDuration(elapsed)),
  ]);

  const errMsg = bp.errorMessage
    ? el("div", { class: "lib-import-book-error", title: bp.errorMessage }, bp.errorMessage)
    : null;

  const dupMsg = bp.duplicateReason
    ? el("div", { class: "lib-import-book-dup-reason" },
        t(`library.import.books.duplicateReason.${bp.duplicateReason}`, { fallback: bp.duplicateReason }))
    : null;

  return el("div", { class: cls, role: "listitem", title: bp.filePath }, [
    el("div", { class: "lib-import-book-name" }, bp.fileName),
    meta,
    errMsg,
    dupMsg,
  ].filter(Boolean));
}

/** @param {number} ms */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Reset state on новый импорт-старт.
 * Вызывается из import-pane-actions при busy → true.
 */
export function resetBooksState() {
  IMPORT_STATE.inFlight.clear();
  IMPORT_STATE.aggregate.discovered = 0;
  IMPORT_STATE.aggregate.processed = 0;
  IMPORT_STATE.aggregate.added = 0;
  IMPORT_STATE.aggregate.duplicate = 0;
  IMPORT_STATE.aggregate.skipped = 0;
  IMPORT_STATE.aggregate.failed = 0;
  IMPORT_STATE.aggregate.startedAt = Date.now();
  rerenderBooksPanel();
}
