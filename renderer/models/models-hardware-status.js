// @ts-check
/**
 * Hardware-strip + LM Studio status + роли пайплайна.
 *
 * v1.0.9 (2026-05-06): блоки «Загруженные модели» и «Загрузить с диска»
 * удалены по запросу — ручное управление VRAM через UI убрано, модели
 * загружаются on-demand при первом use (v1.0.7 evaluator-queue.allowAutoLoad).
 */

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import {
  hardwareSummaryLine,
  offloadHintLine,
} from "./gpu-offload-hint.js";
import {
  ctx,
  errMsg,
  showToast,
  PIPELINE_ROLES,
} from "./models-page-internals.js";
import { mountPipelineStatusWidget } from "./pipeline-status-widget.js";

/* Iter 7: pipeline widget unmount callback — хранится глобально per-mount чтобы
   повторный buildHwStrip (idempotent) не плодил дублирующие подписки на IPC.
   При new mount старый unmount вызывается, новый сохраняется. */
let pipelineWidgetUnmount = /** @type {(() => void) | null} */ (null);

const ROLE_META = {
  crystallizer:         { labelKey: "models.role.crystallizer.label",         helpKey: "models.role.crystallizer.help" },
  evaluator:            { labelKey: "models.role.evaluator.label",            helpKey: "models.role.evaluator.help" },
  vision_ocr:           { labelKey: "models.role.vision_ocr.label",           helpKey: "models.role.vision_ocr.help" },
  vision_illustration:  { labelKey: "models.role.vision_illustration.label",  helpKey: "models.role.vision_illustration.help" },
};

export async function refreshHardware(force = false) {
  if (!ctx.pageRoot) return;
  const textEl = ctx.pageRoot.querySelector("#mp-hw-text");
  const recoEl = ctx.pageRoot.querySelector("#mp-hw-reco");
  if (textEl) textEl.textContent = t("models.hardware.loading");
  if (recoEl) recoEl.textContent = "";
  try {
    if (typeof window.api?.system?.hardware !== "function") {
      ctx.hardwareSnap = null;
      if (textEl) textEl.textContent = t("models.hardware.unknown");
      return;
    }
    ctx.hardwareSnap = await window.api.system.hardware(force);
    renderHardwareStrip();
  } catch (e) {
    ctx.hardwareSnap = null;
    if (textEl) textEl.textContent = t("models.hardware.error", { msg: errMsg(e) });
    if (recoEl) recoEl.textContent = "";
  }
}

export function renderHardwareStrip() {
  if (!ctx.pageRoot) return;
  const textEl = ctx.pageRoot.querySelector("#mp-hw-text");
  const recoEl = ctx.pageRoot.querySelector("#mp-hw-reco");
  if (textEl) textEl.textContent = hardwareSummaryLine(ctx.hardwareSnap, t);
  if (recoEl) recoEl.textContent = offloadHintLine(ctx.hardwareSnap, t);
}

export async function refresh() {
  if (!ctx.pageRoot) return;
  try {
    const [status, loaded, downloaded, roleMap] = await Promise.all([
      window.api.lmstudio.status(),
      window.api.lmstudio.listLoaded(),
      window.api.lmstudio.listDownloaded(),
      window.api.modelRoles.list(PIPELINE_ROLES),
    ]);
    renderStatus(status);
    renderRoles(roleMap, loaded, downloaded);
    renderHardwareStrip();
  } catch (e) {
    showToast(t("models.toast.refresh_failed", { msg: errMsg(e) }));
  }
}

export async function refreshAll() {
  await refreshHardware(true);
  await refresh();
}

function renderStatus(status) {
  const node = ctx.pageRoot?.querySelector("#mp-status-indicator");
  if (!node) return;
  node.textContent = status.online
    ? t("models.status.online", { ver: status.version ? ` v${status.version}` : "" })
    : t("models.status.offline");
  node.className = `mp-status-pill ${status.online ? "mp-status-online" : "mp-status-offline"}`;
}

/**
 * @param {unknown[]} roleMap
 * @param {Array<{ modelKey: string }>} loaded
 * @param {Array<{ modelKey: string }>} downloaded
 */
function renderRoles(roleMap, loaded, downloaded) {
  const host = ctx.pageRoot?.querySelector("#mp-roles");
  if (!host) return;

  /* Bug fix: если пользователь держит открытым нативный <select> для выбора модели,
   * setInterval → refresh() → clear(host) убивает DOM и dropdown закрывается.
   * Пропускаем re-render пока любой из role-select'ов в фокусе. */
  if (document.activeElement && host.contains(document.activeElement)) return;

  clear(host);

  const loadedKeys = new Set(loaded.map((l) => l.modelKey));
  const allModels = [
    ...loaded.map((m) => ({ key: m.modelKey, loaded: true })),
    ...downloaded
      .filter((d) => !loadedKeys.has(d.modelKey))
      .map((d) => ({ key: d.modelKey, loaded: false })),
  ];

  for (const entry of roleMap) {
    const role = /** @type {string} */ (entry.role);
    const meta = ROLE_META[role] ?? { labelKey: null, helpKey: null };
    const label = meta.labelKey ? t(meta.labelKey) : role;
    const help = meta.helpKey ? t(meta.helpKey) : "";

    const prefVal = entry.prefValue ?? "";
    const select = el("select", { class: "mp-role-select" });

    const defaultOpt = el("option", { value: "" },
      prefVal ? t("models.role.auto") : t("models.role.not_selected"));
    select.appendChild(defaultOpt);

    for (const m of allModels) {
      const opt = el("option", { value: m.key }, m.loaded ? `● ${m.key}` : m.key);
      if (m.key === prefVal) opt.selected = true;
      select.appendChild(opt);
    }

    if (prefVal && !allModels.some((m) => m.key === prefVal)) {
      const opt = el("option", { value: prefVal, selected: "selected" }, `${prefVal} (${t("models.role.not_loaded")})`);
      select.appendChild(opt);
    }

    /* Visual-feedback: галочка "✓" появляется на 2 секунды после сохранения,
     * чтобы пользователь видел, что выбор записался в дефолтный профиль. */
    const savedTick = el("span", { class: "mp-role-saved-tick", style: "opacity:0" }, "✓");

    select.addEventListener("change", () => {
      const val = select.value || null;
      void window.api.preferences
        .set({ [entry.prefKey]: val })
        .then(() => {
          showToast(
            val
              ? t("models.toast.role_saved", { role: label, model: val })
              : t("models.toast.role_auto", { role: label }),
            "success",
          );
          savedTick.style.opacity = "1";
          setTimeout(() => { savedTick.style.opacity = "0"; }, 2000);
        })
        .catch((err) => showToast(t("models.toast.role_save_failed", { msg: errMsg(err) })));
    });

    host.appendChild(el("div", { class: "mp-role-row mp-role-row-compact" }, [
      el("div", { class: "mp-role-info" }, [
        el("span", { class: "mp-role-label" }, label),
        help ? el("span", { class: "mp-role-help" }, help) : null,
      ].filter(Boolean)),
      el("div", { class: "mp-role-control" }, [select, savedTick]),
    ]));
  }
}

export function buildHwStrip() {
  /* Iter 14.2 (2026-05-04): UI-блок «GPU/VRAM info + Recommended offload +
     Re-scan» убран по запросу — пользователи знают своё железо, ручной тюн
     им не интересен. Авто-определение GPU/VRAM (`inferGpuOffloadForLmLoad`,
     `pickHardwareAutoModel`) остаётся в коде и работает при загрузке
     моделей и в welcome-wizard'е — просто не отображается на странице
     Models.

     Скрытые элементы остаются в DOM как display:none, чтобы:
       - `renderHardwareStrip()` всё ещё мог записывать в `#mp-hw-text`/
         `#mp-hw-reco` без падения (никаких null-checks по всему коду);
       - `#mp-hw-refresh` существовал на случай восстановления функционала.

     Pipeline-status-widget (live VRAM pressure + scheduler lanes counters)
     ОСТАЁТСЯ видимым — он показывает реальный прогресс импорта, а не
     спецификации железа. */
  const details = el("details", { class: "mp-hw-details", style: "display: none;" }, [
    el("summary", { class: "mp-hw-summary" }, [
      el("span", { id: "mp-hw-text", class: "mp-hw-text" }, t("models.hardware.loading")),
    ]),
    el("div", { class: "mp-hw-expanded" }, [
      el("div", { id: "mp-hw-reco", class: "mp-hw-reco" }, ""),
      el("button", { id: "mp-hw-refresh", class: "btn btn-ghost btn-sm", type: "button" }, t("models.hardware.rescan")),
    ]),
  ]);

  const pipelineHost = el("div", { id: "mp-pipeline-status", class: "mp-pipeline-status" }, []);

  if (pipelineWidgetUnmount) {
    pipelineWidgetUnmount();
    pipelineWidgetUnmount = null;
  }
  queueMicrotask(() => {
    pipelineWidgetUnmount = mountPipelineStatusWidget(pipelineHost);
  });

  return el("div", { class: "mp-hw-strip" }, [details, pipelineHost]);
}

/**
 * Iter 7: явный unmount для хост-страницы (при unmount models-page).
 * Вызывается из models-page.js при destroy если он добавит обработчик.
 * Безопасно вызывать несколько раз.
 */
export function unmountHwStrip() {
  if (pipelineWidgetUnmount) {
    pipelineWidgetUnmount();
    pipelineWidgetUnmount = null;
  }
}
