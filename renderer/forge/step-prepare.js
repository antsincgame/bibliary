// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { STATE } from "./state.js";
import { showToast, errMsg, labeled, mkRange } from "./ui-controls.js";

/** @param {() => void} render */
export function buildStepPrepare(render) {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.source.title")),
    el("div", { class: "card-sub" }, t("forge.source.sub")),
  ]);
  card.appendChild(buildSourceList(render));
  if (STATE.preview) card.appendChild(buildSourcePreview());
  card.appendChild(buildPrepareSection(render));
  card.appendChild(buildAdvancedSplitDetails());
  if (STATE.prepareResult) card.appendChild(buildPrepareResult());
  return card;
}

/** @param {() => void} render */
function buildSourceList(render) {
  const list = el("div", { class: "forge-source-list" });
  void (async () => {
    try {
      const batches = /** @type {string[]} */ (await window.api.forge.listSourceBatches());
      if (batches.length === 0) {
        list.appendChild(el("div", { class: "forge-empty" }, t("forge.source.empty")));
        return;
      }
      for (const file of batches) {
        const row = el("div", { class: "forge-source-row" }, [
          el("span", { class: "forge-source-name" }, file),
          el("button", { class: "btn btn-ghost", type: "button" }, t("forge.source.pick")),
        ]);
        const btn = row.querySelector("button");
        if (btn) {
          btn.addEventListener("click", async () => {
            const path = `data/finetune/batches/${file}`;
            STATE.sourcePath = path;
            STATE.spec.datasetPath = path;
            try {
              STATE.preview = await window.api.forge.previewSource(path);
              showToast(t("forge.toast.source_picked", { count: STATE.preview.total }), "success");
              render();
            } catch (e) {
              showToast(t("forge.toast.preview_fail", { msg: errMsg(e) }), "error");
            }
          });
        }
        list.appendChild(row);
      }
    } catch (e) {
      list.appendChild(el("div", { class: "forge-empty forge-error" }, t("forge.source.error", { msg: errMsg(e) })));
    }
  })();
  return list;
}

function buildSourcePreview() {
  return el("div", { class: "forge-preview" }, [
    el("div", { class: "forge-preview-title" }, t("forge.source.preview", {
      count: STATE.preview.total, errors: STATE.preview.errors,
    })),
    el("pre", { class: "forge-preview-json" }, JSON.stringify(STATE.preview.sample, null, 2)),
  ]);
}

/** @param {() => void} render */
function buildPrepareSection(render) {
  const prepareBtn = el("button", { class: "btn btn-gold", type: "button" }, t("forge.format.prepare"));
  prepareBtn.addEventListener("click", () => void runPrepare(prepareBtn, render));
  return prepareBtn;
}

/** @param {HTMLElement} prepareBtn @param {() => void} render */
async function runPrepare(prepareBtn, render) {
  if (!STATE.sourcePath) {
    showToast(t("forge.toast.prepare_first_unified"), "error");
    return;
  }
  prepareBtn.disabled = true;
  try {
    STATE.prepareResult = await window.api.forge.prepare({
      spec: STATE.spec,
      sourcePath: STATE.sourcePath,
      trainRatio: STATE.trainRatio,
      evalRatio: STATE.evalRatio,
      seed: 42,
    });
    showToast(t("forge.toast.prepare_ok", {
      train: STATE.prepareResult.counts.train,
      val: STATE.prepareResult.counts.val,
    }), "success");
    render();
  } catch (e) {
    showToast(t("forge.toast.prepare_fail", { msg: errMsg(e) }), "error");
  } finally {
    prepareBtn.disabled = false;
  }
}

function buildAdvancedSplitDetails() {
  const trainSlider = mkRange("trainRatio", 0.7, 0.99, 0.01, STATE.trainRatio);
  trainSlider.label.textContent = `${Math.round(STATE.trainRatio * 100)}%`;
  trainSlider.input.addEventListener("input", () => {
    STATE.trainRatio = Number(trainSlider.input.value);
    trainSlider.label.textContent = `${Math.round(STATE.trainRatio * 100)}%`;
  });

  const evalSlider = mkRange("evalRatio", 0, 0.3, 0.01, STATE.evalRatio);
  evalSlider.label.textContent = `${Math.round(STATE.evalRatio * 100)}%`;
  evalSlider.input.addEventListener("input", () => {
    STATE.evalRatio = Number(evalSlider.input.value);
    evalSlider.label.textContent = `${Math.round(STATE.evalRatio * 100)}%`;
  });

  const body = el("div", { class: "forge-collapsible-body" }, [
    el("div", { class: "card-sub" }, t("forge.format.sub")),
    labeled(t("forge.format.train_ratio"), trainSlider.wrap),
    labeled(t("forge.format.eval_ratio"), evalSlider.wrap),
  ]);
  return el("details", { class: "forge-collapsible" }, [
    el("summary", { class: "forge-collapsible-summary" }, t("forge.prepare.advanced_split")),
    body,
  ]);
}

function buildPrepareResult() {
  return el("div", { class: "forge-preview" }, [
    el("div", { class: "forge-preview-title" }, t("forge.format.prepared")),
    el("ul", {}, [
      el("li", {}, `train: ${STATE.prepareResult.counts.train}`),
      el("li", {}, `val: ${STATE.prepareResult.counts.val}`),
      el("li", {}, `eval: ${STATE.prepareResult.counts.eval}`),
      el("li", {}, t("forge.format.errors", { n: STATE.prepareResult.parseErrors.length })),
    ]),
  ]);
}
