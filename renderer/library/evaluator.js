// @ts-check
/**
 * Evaluator-panel: read-only status display.
 *
 * v0.5.0: слоты/пауза/отмена удалены — управление автоматическое.
 * v1.1.2 (Phase C): расширено evaluated/failed counters + visual `is-active`
 *   highlight чтобы пользователь видел разницу между "scanned to library"
 *   (statusbar "added") и "evaluated by AI epistemologist" (этот counter).
 *   До v1.1.2 в UI было одно общее "Added" — пользователю казалось что
 *   оценка ушла вместе со scan'ом, а на самом деле LLM ещё работает.
 */
import { el } from "../dom.js";
import { t } from "../i18n.js";

/**
 * Builds the evaluator panel DOM. v1.1.2: добавлены evaluated/failed
 * counters рядом с queue counter — теперь разделение фаз `scanned →
 * evaluated → failed` явно видно в одной строке.
 * @returns {HTMLElement}
 */
export function buildEvaluatorPanel() {
  const title = el("div", { class: "lib-evaluator-title" }, t("library.import.evaluator.title"));
  const stateEl = el("div", { class: "lib-evaluator-state" }, t("library.import.evaluator.idle"));

  const queueLabel = el("span", { class: "lib-evaluator-meta-label" }, t("library.import.evaluator.queueLabel"));
  const queueValue = el("strong", { class: "lib-evaluator-queue-value" }, "0");

  const evaluatedLabel = el("span", { class: "lib-evaluator-meta-label" }, t("library.import.evaluator.evaluatedLabel"));
  const evaluatedValue = el("strong", { class: "lib-evaluator-evaluated-value" }, "0");

  const failedLabel = el("span", { class: "lib-evaluator-meta-label" }, t("library.import.evaluator.failedLabel"));
  const failedValue = el("strong", { class: "lib-evaluator-failed-value" }, "0");

  const meta = el("div", { class: "lib-evaluator-meta" }, [
    queueLabel, queueValue,
    el("span", { class: "lib-evaluator-meta-sep" }, "·"),
    evaluatedLabel, evaluatedValue,
    el("span", { class: "lib-evaluator-meta-sep" }, "·"),
    failedLabel, failedValue,
  ]);
  return el("div", {
    class: "lib-evaluator-panel",
    title: t("library.import.evaluator.tooltip"),
  }, [title, stateEl, meta]);
}

/**
 * Refresh the evaluator panel inside `root` from live status.
 *
 * v1.1.2: возвращает boolean isActive — caller может использовать для
 * tail-recursive polling (только пока что-то происходит, чтобы не
 * нагружать IPC-канал в idle-состоянии).
 *
 * @param {HTMLElement} root
 * @returns {Promise<boolean>} true когда есть активная работа (queue > 0 или
 *   текущая книга в evaluation), false при idle.
 */
export async function refreshEvaluatorState(root) {
  const panel = /** @type {HTMLElement|null} */ (root.querySelector(".lib-evaluator-panel"));
  const stateEl = root.querySelector(".lib-evaluator-state");
  if (!stateEl) return false;
  /** @type {any} */
  let status = null;
  try { status = await window.api.library.evaluatorStatus(); }
  catch (_e) { console.warn("[evaluator] status fetch failed:", _e); return false; }
  if (!status) return false;

  const queueLength = Number(status.queueLength ?? 0);
  const totalEvaluated = Number(status.totalEvaluated ?? 0);
  const totalFailed = Number(status.totalFailed ?? 0);
  const isActive = !status.paused && (queueLength > 0 || Boolean(status.currentBookId));

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
  const evaluatedValue = root.querySelector(".lib-evaluator-evaluated-value");
  if (evaluatedValue) evaluatedValue.textContent = String(totalEvaluated);
  const failedValue = root.querySelector(".lib-evaluator-failed-value");
  if (failedValue) failedValue.textContent = String(totalFailed);

  if (panel) panel.classList.toggle("is-active", isActive);
  return isActive;
}
