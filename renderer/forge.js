// @ts-check
/**
 * Forge wizard v2.4 — thin mount orchestrator.
 *
 * Implementation split:
 *   forge/state.js        — STATE singleton, defaults, presets, lifecycle
 *   forge/ui-controls.js  — showToast, errMsg, labeled, mkNumber/Check/Select/Range
 *   forge/step-prepare.js — Step 0 (source pick + preview + split)
 *   forge/step-params.js  — Step 1 (presets, base model, ctx, YaRN, VRAM, advanced)
 *   forge/step-run.js     — Step 2 (workspace actions, post-training, footer)
 *   forge/local-run.js    — LocalRunner UI (WSL train, stdout, metrics, GGUF import)
 */
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildNeonHero, neonDivider } from "./components/neon-helpers.js";
import { STATE, STEP_KEYS, _startingLocalRun, setPageRoot, pageRoot } from "./forge/state.js";
import { showToast, errMsg } from "./forge/ui-controls.js";
import { buildStepPrepare } from "./forge/step-prepare.js";
import { buildStepParamsLocal } from "./forge/step-params.js";
import { buildStepRunMinimal, buildFooter } from "./forge/step-run.js";

export function mountForge(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  setPageRoot(root);
  void initialize();
}

export function isForgeBusy() {
  return _startingLocalRun || STATE.localRun.status === "running";
}

async function initialize() {
  if (!STATE.runId) {
    try {
      STATE.runId = /** @type {string} */ (await window.api.forge.nextRunId());
      STATE.spec.runId = STATE.runId;
    } catch (e) {
      showToast(t("forge.toast.init_fail", { msg: errMsg(e) }), "error");
      STATE.runId = `forge-${Date.now()}`;
      STATE.spec.runId = STATE.runId;
    }
  }
  void refreshNativeContext();
  render();
}

async function refreshNativeContext() {
  try {
    const result = /** @type {any} */ (await window.api.yarn.recommend(
      STATE.spec.baseModel,
      STATE.spec.maxSeqLength,
      null,
    ));
    STATE.nativeContext = result?.arch?.nativeTokens ?? null;
    if (STATE.nativeContext) {
      STATE.spec.nativeContextLength = STATE.nativeContext;
    }
  } catch {
    STATE.nativeContext = null;
  }
}

function render() {
  if (!pageRoot) return;
  clear(pageRoot);
  pageRoot.appendChild(buildNeonHero({
    title: t("forge.header.title"),
    subtitle: t("forge.header.sub"),
    pattern: "metatron",
  }));
  pageRoot.appendChild(neonDivider());
  pageRoot.appendChild(buildStepper());
  pageRoot.appendChild(buildToastArea());
  if (STATE.step === 0) pageRoot.appendChild(buildStepPrepare(render));
  else if (STATE.step === 1) pageRoot.appendChild(buildStepParamsLocal(render, refreshNativeContext));
  else if (STATE.step === 2) pageRoot.appendChild(buildStepRunMinimal(render));
  pageRoot.appendChild(buildFooter(render));
}

function buildStepper() {
  const wrap = el("div", {
    class: "forge-stepper",
    role: "group",
    "aria-label": t("forge.stepper.aria_label"),
  });
  STEP_KEYS.forEach((key, i) => {
    const status = i === STATE.step ? "active" : i < STATE.step ? "done" : "future";
    const tooltipText = t(`forge.step.indicator.${status}`);
    const attrs = {
      class: "forge-step-pill forge-step-indicator" +
        (i === STATE.step ? " forge-step-active" : "") +
        (i < STATE.step ? " forge-step-done" : ""),
      title: tooltipText,
    };
    if (i === STATE.step) attrs["aria-current"] = "step";
    wrap.appendChild(
      el("div", attrs, [
        el("span", { class: "forge-step-num" }, String(i + 1)),
        el("span", { class: "forge-step-label" }, t(key)),
      ])
    );
  });
  return wrap;
}

function buildToastArea() {
  return el("div", { id: "forge-toast-area", class: "forge-toast-area" });
}
