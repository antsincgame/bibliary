/**
 * tests/audit-update-batch-ui-dom.test.ts
 *
 * Pure-unit покрытие updateBatchUi (renderer/library/batch-actions.js) —
 * функции, которая переключает DOM-состояние bottom-bar:
 *   - primary button disabled + busy class + label
 *   - cancel-batch button visibility (style.display)
 *   - batch summary текстом текущей книги
 *
 * До этого теста updateBatchUi полностью без покрытия. Любая регрессия
 * (например, забыли .removeAttribute("disabled") после batch-end или
 * заменили cancelBtn.style.display на addClass без эквивалентного toggle)
 * проходила бы в production: кнопка зависает в busy-state, либо cancel-btn
 * остаётся видимым после завершения batch'а.
 *
 * Стратегия: fake root возвращает fake-element-объекты с минимальным API
 * (textContent/setAttribute/removeAttribute/classList/style). Никакой DOM
 * не нужен — node:test работает как чистый юнит.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateBatchUi } from "../renderer/library/batch-actions.js";
import { BATCH, CATALOG } from "../renderer/library/state.js";

/* ─── fake DOM элементы ────────────────────────────────────────────── */

interface FakeBtn {
  textContent: string;
  _attrs: Map<string, string>;
  _classes: Set<string>;
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
  hasAttribute: (k: string) => boolean;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  style: { display: string };
}

function makeFakeBtn(): FakeBtn {
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  return {
    textContent: "",
    _attrs: attrs,
    _classes: classes,
    setAttribute: (k, v) => { attrs.set(k, v); },
    removeAttribute: (k) => { attrs.delete(k); },
    hasAttribute: (k) => attrs.has(k),
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    style: { display: "" },
  };
}

interface FakeRootSetup {
  primary: FakeBtn | null;
  cancel: FakeBtn | null;
  summary: FakeBtn | null;
}

function makeFakeRoot(setup: FakeRootSetup): { querySelector: (sel: string) => FakeBtn | null } {
  return {
    querySelector: (sel: string): FakeBtn | null => {
      if (sel.includes("lib-btn-primary")) return setup.primary;
      if (sel.includes("lib-btn-cancel-batch")) return setup.cancel;
      if (sel.includes("lib-catalog-batch-summary")) return setup.summary;
      return null;
    },
  };
}

function resetState(): void {
  BATCH.active = false;
  BATCH.batchId = null;
  BATCH.total = 0;
  BATCH.done = 0;
  BATCH.skipped = 0;
  BATCH.failed = 0;
  BATCH.currentBookId = null;
  BATCH.currentBookTitle = null;
  BATCH.lastJobId = null;
  BATCH.collection = null;
  CATALOG.rows = [];
  CATALOG.selected.clear();
}

/* ─── primary button: disabled toggle ──────────────────────────────── */

test("[updateBatchUi] BATCH.active=true → primary btn disabled + busy class + non-empty progress label", () => {
  resetState();
  const primary = makeFakeBtn();
  const root = makeFakeRoot({ primary, cancel: null, summary: null });

  BATCH.active = true;
  BATCH.total = 5;
  BATCH.done = 2;
  BATCH.skipped = 1;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);

  assert.equal(primary.hasAttribute("disabled"), true, "must set disabled while active");
  assert.equal(primary.classList.contains("lib-btn-busy"), true, "must add busy class");
  assert.notEqual(primary.textContent, "", "progress label must be non-empty (i18n key fallback OK)");
});

test("[updateBatchUi] BATCH.active=false → primary btn enabled + busy class removed + label restored", () => {
  resetState();
  const primary = makeFakeBtn();
  primary.setAttribute("disabled", "true");
  primary.classList.add("lib-btn-busy");
  primary.textContent = "stale-progress-label";
  const root = makeFakeRoot({ primary, cancel: null, summary: null });

  /* BATCH.active по умолчанию false */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);

  assert.equal(primary.hasAttribute("disabled"), false, "must remove disabled when idle");
  assert.equal(primary.classList.contains("lib-btn-busy"), false, "must remove busy class");
  assert.notEqual(primary.textContent, "stale-progress-label",
    "label must change away from progress text on idle");
  assert.notEqual(primary.textContent, "", "idle label must be non-empty");
});

/* ─── cancel-batch button: visibility toggle ───────────────────────── */

test("[updateBatchUi] BATCH.active=true → cancel-btn style.display = '' (visible)", () => {
  resetState();
  const cancel = makeFakeBtn();
  cancel.style.display = "none"; /* preset hidden */
  const root = makeFakeRoot({ primary: null, cancel, summary: null });

  BATCH.active = true;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);

  assert.equal(cancel.style.display, "", "cancel-btn must become visible during batch");
});

test("[updateBatchUi] BATCH.active=false → cancel-btn style.display = 'none' (hidden)", () => {
  resetState();
  const cancel = makeFakeBtn();
  cancel.style.display = ""; /* preset visible */
  const root = makeFakeRoot({ primary: null, cancel, summary: null });

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);

  assert.equal(cancel.style.display, "none", "cancel-btn must hide when batch not active");
});

/* ─── batch summary: текст текущей книги ───────────────────────────── */

test("[updateBatchUi] BATCH.active=true + currentBookTitle → summary non-empty", () => {
  resetState();
  const summary = makeFakeBtn();
  const root = makeFakeRoot({ primary: null, cancel: null, summary });

  BATCH.active = true;
  BATCH.currentBookTitle = "Test Book";
  BATCH.done = 0;
  BATCH.total = 3;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);

  assert.notEqual(summary.textContent, "", "summary must show progress when book is processing");
});

test("[updateBatchUi] BATCH.active=true + no currentBookTitle → summary empty (no 'undefined' literal)", () => {
  resetState();
  const summary = makeFakeBtn();
  summary.textContent = "stale-text";
  const root = makeFakeRoot({ primary: null, cancel: null, summary });

  BATCH.active = true;
  BATCH.currentBookTitle = null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);

  assert.equal(summary.textContent, "", "summary must clear when no current book title");
});

test("[updateBatchUi] BATCH.active=false → summary empty regardless of stale title", () => {
  resetState();
  const summary = makeFakeBtn();
  summary.textContent = "stale-batch-summary-from-previous-run";
  const root = makeFakeRoot({ primary: null, cancel: null, summary });

  BATCH.active = false;
  BATCH.currentBookTitle = "Stale Title"; /* должно игнорироваться */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);

  assert.equal(summary.textContent, "", "summary must be cleared when batch ends");
});

/* ─── robustness: missing elements ──────────────────────────────────── */

test("[updateBatchUi] no DOM elements present (querySelector → null) → no crash", () => {
  resetState();
  const root = makeFakeRoot({ primary: null, cancel: null, summary: null });

  BATCH.active = true;
  BATCH.currentBookTitle = "X";
  /* Не должно бросать — все 3 ветки guarded if-проверками. */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);
  /* Если дошли сюда — функция выжила без DOM. */
  assert.ok(true);
});

/* ─── идемпотентность ──────────────────────────────────────────────── */

test("[updateBatchUi] idempotent — двойной вызов с тем же state не ломает state", () => {
  resetState();
  const primary = makeFakeBtn();
  const cancel = makeFakeBtn();
  const summary = makeFakeBtn();
  const root = makeFakeRoot({ primary, cancel, summary });

  BATCH.active = true;
  BATCH.currentBookTitle = "Book Idem";
  BATCH.done = 1;
  BATCH.total = 2;

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);
  const t1Disabled = primary.hasAttribute("disabled");
  const t1Display = cancel.style.display;
  const t1Summary = summary.textContent;

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);
  assert.equal(primary.hasAttribute("disabled"), t1Disabled, "disabled stable across redundant calls");
  assert.equal(cancel.style.display, t1Display, "cancel display stable");
  assert.equal(summary.textContent, t1Summary, "summary stable");
});

/* ─── transition active → idle освобождает все controls ────────────── */

test("[updateBatchUi] full transition: active → idle освобождает все controls", () => {
  resetState();
  const primary = makeFakeBtn();
  const cancel = makeFakeBtn();
  const summary = makeFakeBtn();
  const root = makeFakeRoot({ primary, cancel, summary });

  /* Phase 1: active */
  BATCH.active = true;
  BATCH.currentBookTitle = "Active Phase";
  BATCH.done = 1;
  BATCH.total = 3;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);
  assert.equal(primary.hasAttribute("disabled"), true);
  assert.equal(primary.classList.contains("lib-btn-busy"), true);
  assert.equal(cancel.style.display, "");
  assert.notEqual(summary.textContent, "");

  /* Phase 2: idle */
  BATCH.active = false;
  BATCH.currentBookTitle = null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  updateBatchUi(root as any);
  assert.equal(primary.hasAttribute("disabled"), false, "primary must be re-enabled");
  assert.equal(primary.classList.contains("lib-btn-busy"), false, "busy class must clear");
  assert.equal(cancel.style.display, "none", "cancel must hide");
  assert.equal(summary.textContent, "", "summary must clear");
});
