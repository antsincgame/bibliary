// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { buildEvalPanel } from "../components/eval-panel.js";
import { STATE, LAST_STEP } from "./state.js";
import { showToast, errMsg } from "./ui-controls.js";
import { buildLocalRunSection } from "./local-run.js";

/** @param {() => void} render */
export function buildStepRunMinimal(render) {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.run.workspace.title")),
    el("div", { class: "card-sub" }, t("forge.run.workspace.sub")),
  ]);
  card.appendChild(buildRunSummary());
  card.appendChild(buildWorkspaceActions(render));
  card.appendChild(buildLocalRunSection(render));
  card.appendChild(buildPostTrainingDetails());
  return card;
}

function buildRunSummary() {
  const ctxLabel = STATE.spec.useYarn && STATE.spec.yarnFactor > 1
    ? `${STATE.spec.maxSeqLength} (YaRN ×${STATE.spec.yarnFactor})`
    : String(STATE.spec.maxSeqLength);
  return el("ul", { class: "forge-run-summary" }, [
    el("li", {}, `runId: ${STATE.spec.runId}`),
    el("li", {}, `model: ${STATE.spec.baseModel}`),
    el("li", {}, `method: ${STATE.spec.method.toUpperCase()} r=${STATE.spec.loraR} α=${STATE.spec.loraAlpha}`),
    el("li", {}, `context: ${ctxLabel}`),
    el("li", {}, `dataset: ${STATE.spec.datasetPath}`),
  ]);
}

/** @param {() => void} render */
function buildWorkspaceActions(_render) {
  const wrap = el("div", { class: "forge-workspace-actions" });
  const generateBtn = el("button", { class: "btn btn-gold", type: "button" }, t("forge.run.workspace.generate"));
  const openBtn = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.run.workspace.open"));
  const pathBox = el("div", { class: "forge-workspace-path" });

  generateBtn.addEventListener("click", async () => {
    generateBtn.disabled = true;
    try {
      const result = /** @type {any} */ (await window.api.forge.generateBundle({
        spec: STATE.spec,
        runId: STATE.spec.runId,
        target: "bundle",
      }));
      STATE.bundleDir = result.bundleDir;
      showToast(t("forge.toast.workspace_ok", { dir: STATE.bundleDir }), "success");
      renderPath();
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    } catch (e) {
      showToast(t("forge.toast.workspace_fail", { msg: errMsg(e) }), "error");
    } finally {
      generateBtn.disabled = false;
    }
  });

  openBtn.addEventListener("click", async () => {
    try {
      await window.api.forge.openBundleFolder(STATE.spec.runId);
    } catch (e) {
      showToast(t("forge.toast.open_fail", { msg: errMsg(e) }), "error");
    }
  });

  function renderPath() {
    clear(pathBox);
    if (!STATE.bundleDir) return;
    const dir = STATE.bundleDir;
    const copyBtn = el("button", {
      class: "btn btn-ghost btn-small", type: "button",
      title: t("forge.run.workspace.copy_path"),
    }, t("forge.run.workspace.copy_path"));
    copyBtn.addEventListener("click", () => void copyPath(dir));
    pathBox.appendChild(el("span", {}, t("forge.run.workspace.path_label")));
    pathBox.appendChild(el("code", {}, dir));
    pathBox.appendChild(copyBtn);
  }

  if (STATE.bundleDir) renderPath();
  wrap.appendChild(generateBtn);
  wrap.appendChild(openBtn);
  wrap.appendChild(pathBox);
  return wrap;
}

async function copyPath(dir) {
  if (!dir) return;
  try {
    await navigator.clipboard.writeText(dir);
    showToast(t("forge.toast.path_copied"), "success");
  } catch { /* clipboard blocked — path is visible in UI */ }
}

function buildPostTrainingDetails() {
  const body = el("div", { class: "forge-collapsible-body" });

  const markRow = el("div", { class: "forge-mark-row" });
  for (const status of ["succeeded", "failed", "cancelled"]) {
    const b = el("button", { class: "btn btn-ghost", type: "button" }, t(`forge.run.mark.${status}`));
    b.addEventListener("click", async () => {
      try {
        await window.api.forge.markStatus(STATE.spec.runId, status);
        showToast(t("forge.toast.marked", { status: t(`forge.run.mark.${status}`) }), "success");
      } catch (e) {
        showToast(t("forge.toast.mark_fail", { msg: errMsg(e) }), "error");
      }
    });
    markRow.appendChild(b);
  }
  body.appendChild(markRow);

  if (STATE.prepareResult?.evalPath) {
    const evalSection = el("div", { class: "forge-eval-section", "data-mode-min": "pro" }, [
      el("div", { class: "card-title" }, t("eval.title")),
      el("div", { class: "card-sub" }, t("eval.sub")),
    ]);
    evalSection.appendChild(buildEvalPanel({
      evalPath: STATE.prepareResult.evalPath,
      baseModelDefault: STATE.spec.baseModel,
      tunedModelDefault: `bibliary-finetuned/${STATE.spec.runId}`,
    }));
    body.appendChild(evalSection);
  }

  return el("details", { class: "forge-collapsible" }, [
    el("summary", { class: "forge-collapsible-summary" }, t("forge.run.post_section")),
    body,
  ]);
}

/** @param {() => void} render */
export function buildFooter(render) {
  const wrap = el("div", { class: "forge-footer" });
  if (STATE.step > 0) {
    const back = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.back"));
    back.addEventListener("click", () => {
      STATE.step--;
      render();
    });
    wrap.appendChild(back);
  }
  if (STATE.step < LAST_STEP) {
    const next = el("button", { class: "btn btn-gold", type: "button" }, t("forge.next"));
    next.addEventListener("click", () => {
      if (STATE.step === 0 && !STATE.prepareResult) {
        showToast(t("forge.toast.prepare_first_unified"), "error");
        return;
      }
      if (STATE.step === 1 && !String(STATE.spec.baseModel ?? "").trim()) {
        showToast(t("forge.toast.basemodel_required"), "error");
        return;
      }
      STATE.step++;
      render();
    });
    wrap.appendChild(next);
  }
  return wrap;
}
