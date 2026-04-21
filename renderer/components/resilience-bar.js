// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";

let bar = null;
let unsubOff = null;
let unsubOn = null;
let hideTimer = null;

let HIDE_DELAY_MS = 4000;

(async () => {
  try {
    const prefs = await window.api?.preferences?.getAll();
    if (prefs && typeof prefs.resilienceBarHideDelayMs === "number") {
      HIDE_DELAY_MS = prefs.resilienceBarHideDelayMs;
    }
  } catch { /* default */ }
})();

/**
 * Подключает глобальный resilience-bar к корню документа.
 * Показывает non-blocking badge при offline LM Studio + auto-resume notification.
 *
 * a11y: role="status" + aria-live="polite" — screen readers объявят сообщение
 * без прерывания контекста пользователя.
 */
export function mountResilienceBar() {
  if (bar) return;
  if (!window.api?.resilience) return;

  bar = el(
    "div",
    {
      id: "resilience-bar",
      class: "resilience-bar hidden",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    [
      el("span", { class: "resilience-bar-icon", "aria-hidden": "true" }, "⚠"),
      el("span", { id: "resilience-bar-text" }, ""),
    ]
  );
  document.body.appendChild(bar);

  unsubOff = window.api.resilience.onLmstudioOffline(() => {
    clearHideTimer();
    show(t("resilience.lmstudio.offline.banner"), "warn");
  });
  unsubOn = window.api.resilience.onLmstudioOnline(() => {
    clearHideTimer();
    show(t("resilience.lmstudio.online.banner"), "ok");
    hideTimer = setTimeout(() => {
      hide();
      hideTimer = null;
    }, HIDE_DELAY_MS);
  });
}

export function unmountResilienceBar() {
  clearHideTimer();
  if (unsubOff) {
    unsubOff();
    unsubOff = null;
  }
  if (unsubOn) {
    unsubOn();
    unsubOn = null;
  }
  if (bar) {
    bar.remove();
    bar = null;
  }
}

function show(message, kind) {
  if (!bar) return;
  const text = bar.querySelector("#resilience-bar-text");
  if (text) text.textContent = message;
  bar.className = `resilience-bar ${kind === "ok" ? "ok" : "warn"}`;
}

function hide() {
  if (bar) bar.className = "resilience-bar hidden";
}

function clearHideTimer() {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}
