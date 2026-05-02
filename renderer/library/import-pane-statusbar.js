// @ts-check
/**
 * Status bar для импорта — счётчики (added/duplicate/skipped/failed),
 * прогресс-бар и ETA. Reads from IMPORT_STATE.aggregate.
 */

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { IMPORT_STATE } from "./state.js";

let STATUSBAR_REF = null;

export function buildImportStatusBar() {
  if (STATUSBAR_REF) return STATUSBAR_REF;

  const counters = el("div", { class: "lib-import-statusbar-counters" }, [
    el("span", { class: "lib-import-statusbar-progress" }, "0/0"),
    el("span", { class: "lib-import-statusbar-spacer" }, "·"),
    counter("added", "lib-import-statusbar-added"),
    counter("duplicate", "lib-import-statusbar-dup"),
    counter("skipped", "lib-import-statusbar-skip"),
    counter("failed", "lib-import-statusbar-fail"),
  ]);

  const speed = el("span", { class: "lib-import-statusbar-speed" }, "");
  const eta = el("span", { class: "lib-import-statusbar-eta" }, "");

  const right = el("div", { class: "lib-import-statusbar-right" }, [speed, eta]);

  const progressFill = el("div", { class: "lib-import-statusbar-fill" });
  const progressTrack = el("div", { class: "lib-import-statusbar-track" }, [progressFill]);

  const bar = el("div", { class: "lib-import-statusbar" }, [counters, right, progressTrack]);
  /** @type {any} */ (bar)._counters = counters;
  /** @type {any} */ (bar)._speed = speed;
  /** @type {any} */ (bar)._eta = eta;
  /** @type {any} */ (bar)._fill = progressFill;
  STATUSBAR_REF = bar;
  return bar;
}

/**
 * @param {string} key
 * @param {string} cls
 */
function counter(key, cls) {
  return el("span", {
    class: `lib-import-statusbar-counter ${cls}`,
    "data-key": key,
    title: t(`library.import.statusbar.${key}.tooltip`),
  }, [
    el("span", { class: "lib-import-statusbar-counter-label" }, t(`library.import.statusbar.${key}`)),
    el("span", { class: "lib-import-statusbar-counter-value", "data-value": "0" }, "0"),
  ]);
}

export function rerenderStatusBar() {
  if (!STATUSBAR_REF) return;
  const bar = STATUSBAR_REF;
  const agg = IMPORT_STATE.aggregate;

  const counters = /** @type {HTMLElement} */ (/** @type {any} */ (bar)._counters);
  const progressEl = counters?.querySelector(".lib-import-statusbar-progress");
  if (progressEl) {
    progressEl.textContent = `${agg.processed}/${Math.max(agg.discovered, agg.processed)}`;
  }
  setCounter(counters, "added", agg.added);
  setCounter(counters, "duplicate", agg.duplicate);
  setCounter(counters, "skipped", agg.skipped);
  setCounter(counters, "failed", agg.failed);

  const speed = /** @type {HTMLElement} */ (/** @type {any} */ (bar)._speed);
  const eta = /** @type {HTMLElement} */ (/** @type {any} */ (bar)._eta);
  const fill = /** @type {HTMLElement} */ (/** @type {any} */ (bar)._fill);

  const elapsedMs = agg.startedAt ? Date.now() - agg.startedAt : 0;
  if (speed) {
    if (elapsedMs > 1000 && agg.processed > 0) {
      const perMin = (agg.processed / (elapsedMs / 60000));
      speed.textContent = t("library.import.statusbar.speed", { value: perMin.toFixed(1) });
    } else {
      speed.textContent = "";
    }
  }

  if (eta) {
    const remaining = Math.max(0, agg.discovered - agg.processed);
    if (elapsedMs > 2000 && agg.processed > 0 && remaining > 0) {
      const perMs = agg.processed / elapsedMs;
      const etaMs = remaining / perMs;
      eta.textContent = t("library.import.statusbar.eta", { value: formatEta(etaMs) });
    } else {
      eta.textContent = "";
    }
  }

  if (fill) {
    const total = Math.max(1, agg.discovered);
    const pct = Math.min(100, Math.round((agg.processed / total) * 100));
    fill.style.width = `${pct}%`;
  }
}

/** @param {HTMLElement|null} root @param {string} key @param {number} v */
function setCounter(root, key, v) {
  if (!root) return;
  const el = /** @type {HTMLElement|null} */ (root.querySelector(`[data-key="${key}"] [data-value]`));
  if (el) el.textContent = String(v);
}

/** @param {number} ms */
function formatEta(ms) {
  if (ms < 60_000) return `~${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `~${Math.round(ms / 60_000)}m`;
  return `~${(ms / 3_600_000).toFixed(1)}h`;
}
