// @ts-check
/**
 * Shared state + helpers для страницы Models.
 * Mutable `ctx` — единственный источник правды для всех models-page-*.js.
 */

import { el } from "../dom.js";
import { t } from "../i18n.js";

export const REFRESH_MS = 8000;
export const TOAST_TTL_MS = 5000;

/** Роли, отображаемые на странице моделей. */
export const PIPELINE_ROLES = [
  "crystallizer",
  "evaluator",
  "vision_ocr",
  "vision_illustration",
];

/**
 * @type {{
 *   pageRoot: HTMLElement | null;
 *   hardwareSnap: unknown | null;
 *   busy: boolean;
 * }}
 */
export const ctx = {
  pageRoot: null,
  hardwareSnap: null,
  busy: false,
};

export function showToast(msg, kind = "error") {
  const area = ctx.pageRoot?.querySelector(".mp-toast-area");
  if (!area) return;
  const div = el("div", { class: `toast toast-${kind}`, role: "status", "aria-live": "polite" }, msg);
  area.appendChild(div);
  setTimeout(() => div.remove(), TOAST_TTL_MS);
}

export function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

export function setControlsDisabled(disabled) {
  if (!ctx.pageRoot) return;
  ctx.pageRoot.querySelectorAll("button, select").forEach((node) => {
    if (disabled) {
      node.dataset.prevDisabled = node.disabled ? "1" : "0";
      node.disabled = true;
    } else {
      if (node.dataset.prevDisabled === "0") node.disabled = false;
      delete node.dataset.prevDisabled;
    }
  });
}

/**
 * Обёртка, делающая UI «занятым» на время асинхронной операции.
 * `refreshFn` — обычно `refresh()` из roles-render, чтобы UI догнал свежее
 * состояние LM Studio после load/unload.
 */
export async function withBusy(fn, errKey, refreshFn) {
  if (ctx.busy) {
    showToast(t("models.toast.busy"));
    return;
  }
  ctx.busy = true;
  setControlsDisabled(true);
  try {
    await fn();
    if (typeof refreshFn === "function") await refreshFn();
  } catch (e) {
    showToast(t(errKey, { msg: errMsg(e) }));
  } finally {
    ctx.busy = false;
    setControlsDisabled(false);
  }
}

