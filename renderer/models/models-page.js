// @ts-check
/**
 * Страница «Модели» (route: models) — entry point.
 * Хост: hardware strip, конфиг ролей, advanced, actions log.
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
  unmountHwStrip,
} from "./models-hardware-status.js";
import { buildAdvancedPanel } from "./models-page-advanced.js";
import { buildActionsLogPanel } from "./models-actions-log-panel.js";

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
        (() => {
          /* «Авто-настройка» — heuristic auto-pick задач из загруженных
           * моделей. Один клик распределяет reader/extractor/vision-ocr
           * через эвристику в auto-config.ts (vision capability + reasoning
           * markers + размер) и записывает в preferences. */
          const btn = el("button", {
            class: "btn btn-ghost btn-sm mp-autoconfig-btn",
            type: "button",
            title: t("models.btn.autoConfigure.tooltip"),
          }, t("models.btn.autoConfigure"));
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            const orig = btn.textContent;
            btn.textContent = t("models.btn.autoConfigure.busy");
            try {
              const res = await window.api.lmstudio.autoConfigureModels();
              if (res.ok) {
                /* UI feedback: краткая сводка какие назначения сделаны. */
                const lines = res.reasons.map((r) =>
                  `${r.task}: ${r.modelKey ?? "—"} (${r.reason})`,
                );
                const { showAlert } = await import("../components/ui-dialog.js");
                await showAlert(lines.join("\n"), {
                  title: t("models.btn.autoConfigure.doneTitle"),
                });
                /* Re-render Models page чтобы select'ы показали новые prefs. */
                await refreshAll();
              } else {
                const { showAlert } = await import("../components/ui-dialog.js");
                await showAlert(res.error ?? "auto-configure failed", {
                  title: t("models.btn.autoConfigure.errorTitle"),
                });
              }
            } catch (e) {
              const { showAlert } = await import("../components/ui-dialog.js");
              await showAlert(e instanceof Error ? e.message : String(e), {
                title: t("models.btn.autoConfigure.errorTitle"),
              });
            } finally {
              btn.disabled = false;
              btn.textContent = orig;
            }
          });
          return btn;
        })(),
      ]),
      el("p", { class: "mp-header-sub" }, t("models.header.sub_compact")),
    ]),

    /* Железо — компактно, свёрнуто, не занимает место. */
    buildHwStrip(),

    el("div", { class: "mp-toast-area" }),

    el("section", { class: "mp-card mp-roles-card mp-card-compact" }, [
      el("h2", { class: "mp-card-title" }, t("models.roles.title")),
      el("p", { class: "mp-card-sub" }, t("models.header.sub_simple")),
      el("div", { id: "mp-roles", class: "mp-roles-list mp-roles-list-compact" }, t("models.card.loading")),
      buildAdvancedPanel(),
      /* v1.0.7: панель структурированного лога действий с LM Studio.
         Позволяет пользователю увидеть КТО / КОГДА / ПОЧЕМУ грузил модели. */
      buildActionsLogPanel(),
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
  /* Iter 8А: явная отписка pipeline-status-widget от IPC, чтобы `resilience:
     scheduler-snapshot` / `resilience:lmstudio-pressure` listeners не висели
     после ухода с Models page. unmountHwStrip() идемпотентен. */
  unmountHwStrip();
  ctx.pageRoot = null;
  ctx.busy = false;
  ctx.hardwareSnap = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", unmountModels);
}
