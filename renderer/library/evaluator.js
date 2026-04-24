// @ts-check
/**
 * Evaluator-panel: status, pause/resume, cancel current, slots control.
 */
import { el } from "../dom.js";
import { t } from "../i18n.js";

/**
 * Builds the full evaluator panel DOM (status + meta + controls).
 * @returns {HTMLElement}
 */
export function buildEvaluatorPanel() {
  const title = el("div", { class: "lib-evaluator-title" }, t("library.import.evaluator.title"));
  const stateEl = el("div", { class: "lib-evaluator-state" }, t("library.import.evaluator.idle"));

  const queueLabel = el("span", { class: "lib-evaluator-meta-label" }, t("library.import.evaluator.queueLabel"));
  const queueValue = el("strong", { class: "lib-evaluator-queue-value" }, "0");

  const slotsLabel = el("label", {
    class: "lib-evaluator-meta-label",
    for: "lib-evaluator-slots-input",
    title: t("library.import.evaluator.tooltip.slots"),
  }, t("library.import.evaluator.slotsLabel"));
  const slotsInput = /** @type {HTMLInputElement} */ (el("input", {
    type: "number",
    id: "lib-evaluator-slots-input",
    class: "lib-evaluator-slots-input",
    min: "1",
    max: "16",
    step: "1",
    value: "2",
  }));
  slotsInput.addEventListener("change", async () => {
    const n = Math.max(1, Math.min(16, Math.floor(Number(slotsInput.value) || 2)));
    slotsInput.value = String(n);
    try {
      const r = /** @type {any} */ (await window.api.library.evaluatorSetSlots(n));
      if (r && typeof r.slots === "number") slotsInput.value = String(r.slots);
    } catch (e) { console.warn("[evaluator.setSlots]", e); }
  });

  const pauseBtn = /** @type {HTMLButtonElement} */ (el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost lib-evaluator-btn-pause",
  }, t("library.import.evaluator.btn.pause")));
  pauseBtn.addEventListener("click", async () => {
    pauseBtn.disabled = true;
    try {
      const isPaused = pauseBtn.dataset.state === "paused";
      if (isPaused) await window.api.library.evaluatorResume();
      else await window.api.library.evaluatorPause();
      const root = document.getElementById("library-root");
      if (root) void refreshEvaluatorState(root);
    } catch (e) { console.warn("[evaluator.pause/resume]", e); }
    finally { pauseBtn.disabled = false; }
  });

  const cancelBtn = /** @type {HTMLButtonElement} */ (el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost lib-evaluator-btn-cancel",
  }, t("library.import.evaluator.btn.cancelCurrent")));
  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true;
    try { await window.api.library.evaluatorCancelCurrent(); }
    catch (e) { console.warn("[evaluator.cancelCurrent]", e); }
    finally { cancelBtn.disabled = false; }
  });

  const meta = el("div", { class: "lib-evaluator-meta" }, [
    queueLabel, queueValue,
    el("span", { class: "lib-evaluator-meta-sep" }, "\u00b7"),
    slotsLabel, slotsInput,
  ]);
  const actions = el("div", { class: "lib-evaluator-actions" }, [pauseBtn, cancelBtn]);
  return el("div", { class: "lib-evaluator-panel" }, [title, stateEl, meta, actions]);
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

  const pauseBtn = /** @type {HTMLButtonElement|null} */ (root.querySelector(".lib-evaluator-btn-pause"));
  if (pauseBtn) {
    if (status.paused) {
      pauseBtn.textContent = t("library.import.evaluator.btn.resume");
      pauseBtn.dataset.state = "paused";
    } else {
      pauseBtn.textContent = t("library.import.evaluator.btn.pause");
      pauseBtn.dataset.state = "running";
    }
  }

  const cancelBtn = /** @type {HTMLButtonElement|null} */ (root.querySelector(".lib-evaluator-btn-cancel"));
  if (cancelBtn) cancelBtn.disabled = !status.running;

  const slotsInput = /** @type {HTMLInputElement|null} */ (root.querySelector(".lib-evaluator-slots-input"));
  if (slotsInput && document.activeElement !== slotsInput) {
    try {
      const n = await window.api.library.evaluatorGetSlots();
      if (typeof n === "number" && n >= 1) slotsInput.value = String(n);
    } catch (_e) { /* tolerate: slots read non-critical */ }
  }
}
