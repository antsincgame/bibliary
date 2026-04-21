// @ts-check
/**
 * UI Mode toggle (Simple / Advanced / Pro) — глобальный переключатель уровня сложности.
 *
 * Хранится в localStorage. Применяется к <body data-ui-mode="..."> при mount.
 * Все advanced/pro поля в DOM получают атрибут data-mode-min="advanced|pro" —
 * CSS селекторы ниже скрывают их в нижних режимах.
 *
 * Cycle при клике: simple → advanced → pro → simple
 */

const STORAGE_KEY = "bibliary_ui_mode";
/** @type {ReadonlyArray<UiMode>} */
const ORDER = ["simple", "advanced", "pro"];
const DEFAULT = "simple";

/** @typedef {"simple"|"advanced"|"pro"} UiMode */

const listeners = new Set();

/** @returns {UiMode} */
export function getMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "simple" || stored === "advanced" || stored === "pro") return stored;
  } catch {}
  return DEFAULT;
}

/** @param {UiMode} mode */
export function setMode(mode) {
  if (!ORDER.includes(mode)) return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {}
  applyToDocument();
  for (const fn of listeners) fn(mode);
}

export function cycleMode() {
  const cur = getMode();
  const idx = ORDER.indexOf(cur);
  const next = ORDER[(idx + 1) % ORDER.length];
  setMode(next);
}

/** @param {(mode: UiMode) => void} fn */
export function onModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyToDocument() {
  const mode = getMode();
  document.body.dataset.uiMode = mode;
}
