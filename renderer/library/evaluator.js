// @ts-check
/**
 * Evaluator-panel: read-only status display.
 *
 * v0.5.0: слоты/пауза/отмена удалены — управление автоматическое.
 * Панель показывает только текущий статус и длину очереди.
 */
import { el } from "../dom.js";
import { t } from "../i18n.js";

/**
 * Builds the evaluator panel DOM (status + queue counter).
 * @returns {HTMLElement}
 */
export function buildEvaluatorPanel() {
  const title = el("div", { class: "lib-evaluator-title" }, t("library.import.evaluator.title"));
  const stateEl = el("div", { class: "lib-evaluator-state" }, t("library.import.evaluator.idle"));

  const queueLabel = el("span", { class: "lib-evaluator-meta-label" }, t("library.import.evaluator.queueLabel"));
  const queueValue = el("strong", { class: "lib-evaluator-queue-value" }, "0");

  const meta = el("div", { class: "lib-evaluator-meta" }, [queueLabel, queueValue]);
  return el("div", { class: "lib-evaluator-panel" }, [title, stateEl, meta]);
}

/**
 * Refresh the evaluator panel inside `root` from live status.
 * @param {HTMLElement} root
 */
export async function refreshEvaluatorState(root) {
  const stateEl = root.querySelector(".lib-evaluator-state");
  if (!stateEl) return;
  /** @type {any} */
  let status = null;
  try { status = await window.api.library.evaluatorStatus(); }
  catch (_e) { console.warn("[evaluator] status fetch failed:", _e); return; }
  if (!status) return;

  const queueLength = Number(status.queueLength ?? 0);
  if (status.paused) {
    stateEl.textContent = t("library.import.evaluator.paused", { n: String(queueLength) });
  } else if (status.currentTitle) {
    stateEl.textContent = t("library.import.evaluator.busy", {
      title: status.currentTitle,
      n: String(queueLength),
    });
  } else {
    stateEl.textContent = t("library.import.evaluator.idle");
  }

  const queueValue = root.querySelector(".lib-evaluator-queue-value");
  if (queueValue) queueValue.textContent = String(queueLength);
}
