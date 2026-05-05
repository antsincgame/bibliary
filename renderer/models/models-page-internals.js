// @ts-check
/**
 * Shared state + helpers для страницы Models.
 *
 * Извлечено из `models-page.js` (Phase 2.4 cross-platform roadmap, 2026-04-30).
 * Cross-cutting concerns: контекст монтирования (`ctx`), toast'ы, busy-обёртки,
 * apply-recommendations bridge — всё что используется и в карточке Olympics
 * (controls), и в renderOlympicsReport, и в hardware/roles renderer'ах.
 *
 * Шаблон работы: модули импортят `ctx` и читают/пишут `ctx.pageRoot`,
 * `ctx.busy` и т.д. Это отвергает прямую передачу контекста через
 * параметры — слишком много функций, слишком сильное coupling по аргументам.
 * Mutable shared object — meh, но компактно для renderer-only кода.
 */

import { el } from "../dom.js";
import { t } from "../i18n.js";

export const REFRESH_MS = 8000;
export const TOAST_TTL_MS = 5000;

/** Роли, отображаемые на странице моделей.
 * judge удалён — delta-extractor заменил отдельный judge-шаг.
 * Дисциплина judge-bst тоже удалена из Olympics (2026-04-30) — была sanity-test
 * без production-применения. **Должно совпадать с `ALL_ROLES`** в
 * `models-page-olympics-labels.js`. */
export const PIPELINE_ROLES = [
  "crystallizer",
  "evaluator",
  "vision_ocr",
  "vision_illustration",
];

/**
 * Mutable shared state — единственный источник правды для всех models-page-*.js.
 * Mounted/unmounted lifecycle живёт в `models-page.js` (entry).
 *
 * @type {{
 *   pageRoot: HTMLElement | null;
 *   hardwareSnap: unknown | null;
 *   busy: boolean;
 *   olympicsBusy: boolean;
 *   olympicsDebugVisible: boolean;
 * }}
 */
export const ctx = {
  pageRoot: null,
  hardwareSnap: null,
  busy: false,
  olympicsBusy: false,
  olympicsDebugVisible: false,
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

/**
 * Iter 14.2 (2026-05-04): функция `applyRecommendations` удалена.
 *
 * Кнопка «Распределить роли» убрана из UI — распределение чемпионов теперь
 * происходит АВТОМАТИЧЕСКИ сразу после прогона Олимпиады в
 * `runOlympicsAndShow()`. Auto-apply путь делает свой собственный
 * `applyOlympicsRecommendations` IPC-вызов и refresh() — отдельная общая
 * функция здесь больше не нужна, и `flashAppliedRoleSelects` стал мёртвым
 * вместе с ней. Логирование назначенных ролей делается в лог Олимпиады.
 */
