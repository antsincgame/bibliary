// @ts-check
/**
 * Страница «Модели» (route: models) — entry point.
 *
 * Реальная реализация разнесена на 5 модулей по ответственности (Phase 2.4
 * cross-platform roadmap, 2026-04-30):
 *
 *   - `models-page-internals.js`           — shared state (ctx) + toast / busy / apply
 *   - `models-hardware-status.js`          — hardware strip + status + loaded + roles
 *   - `models-page-olympics-labels.js`     — лейблы дисциплин и ролей (атмосфера)
 *   - `models-page-olympics-controls.js`   — карточка Олимпиады + advanced + run/cancel
 *   - `models-page-olympics-report.js`     — рендер отчёта Олимпиады
 *
 * Этот файл оставляет только: `mountModels`, `unmountModels`, `buildLayout` и
 * минимальный orchestrator (timer, locale subscription).
 */

import { el } from "../dom.js";
import { t, onLocaleChange } from "../i18n.js";
import { ctx, REFRESH_MS } from "./models-page-internals.js";
import {
  refresh,
  refreshHardware,
  renderHardwareStrip,
  refreshAll,
  buildHwStrip,
} from "./models-hardware-status.js";
import { buildOlympicsCard } from "./models-page-olympics-controls.js";

let refreshTimer = null;
let preferencesUnsubscribe = null;
let localeUnsubscribe = null;

function buildLayout() {
  return el("div", { class: "models-page" }, [
    el("div", { class: "mp-header" }, [
      el("div", { class: "mp-header-row" }, [
        el("h1", { class: "mp-title" }, t("models.header.title")),
        el("span", { id: "mp-status-indicator", class: "mp-status-pill mp-status-offline" }, t("models.status.offline")),
        (() => {
          const btn = el("button", { class: "btn btn-ghost btn-sm", type: "button", title: t("models.btn.refresh_all") }, "↻");
          btn.addEventListener("click", () => void refreshAll());
          return btn;
        })(),
      ]),
      el("p", { class: "mp-header-sub" }, t("models.header.sub_compact")),
    ]),

    /* Олимпиада — НАВЕРХУ: это главная точка входа для автонастройки. */
    buildOlympicsCard(),

    /* Железо — компактно, свёрнуто, не занимает место. */
    buildHwStrip(),

    el("div", { class: "mp-toast-area" }),

    el("div", { class: "mp-grid" }, [
      el("section", { class: "mp-card mp-card-compact" }, [
        el("h2", { class: "mp-card-title" }, t("models.card.loaded")),
        el("div", { id: "mp-loaded", class: "mp-model-list" }, t("models.card.loading")),
      ]),
      el("section", { class: "mp-card mp-card-compact" }, [
        el("h2", { class: "mp-card-title" }, t("models.card.from_disk")),
        el("div", { id: "mp-downloaded", class: "mp-model-list" }, t("models.card.loading")),
      ]),
    ]),

    el("section", { class: "mp-card mp-roles-card mp-card-compact" }, [
      el("h2", { class: "mp-card-title" }, t("models.roles.title")),
      el("p", { class: "mp-card-sub" }, t("models.header.sub_simple")),
      el("div", { id: "mp-roles", class: "mp-roles-list mp-roles-list-compact" }, t("models.card.loading")),
    ]),
  ]);
}

export function mountModels(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  ctx.pageRoot = root;
  root.appendChild(buildLayout());

  const hwBtn = root.querySelector("#mp-hw-refresh");
  if (hwBtn) hwBtn.addEventListener("click", () => void refreshHardware(true).then(() => renderHardwareStrip()));

  void refreshHardware(false).then(() => refresh());

  if (typeof window.api.preferences?.onChanged === "function") {
    preferencesUnsubscribe = window.api.preferences.onChanged(() => {
      if (!ctx.busy) void refresh();
    });
  }

  localeUnsubscribe = onLocaleChange(() => {
    if (ctx.pageRoot && !ctx.busy) void refreshAll();
  });

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!ctx.busy) void refresh();
  }, REFRESH_MS);
}

export function unmountModels() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (typeof preferencesUnsubscribe === "function") {
    preferencesUnsubscribe();
    preferencesUnsubscribe = null;
  }
  if (typeof localeUnsubscribe === "function") {
    localeUnsubscribe();
    localeUnsubscribe = null;
  }
  ctx.pageRoot = null;
  ctx.busy = false;
  ctx.hardwareSnap = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", unmountModels);
}
