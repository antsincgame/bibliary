// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { buildContextSlider } from "../components/context-slider.js";
import { buildVramCalculator } from "../components/vram-calc.js";
import { STATE, PRESETS_BY_QUALITY, guessParamsFromName } from "./state.js";
import { showToast, labeled, mkNumber, mkCheck, mkSelect } from "./ui-controls.js";

/**
 * @param {() => void} render
 * @param {() => Promise<void>} refreshNativeContext
 */
export function buildStepParamsLocal(render, refreshNativeContext) {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.params.title")),
    el("div", { class: "card-sub" }, t("forge.params.sub")),
  ]);
  card.appendChild(buildPresetsRow(render));
  card.appendChild(labeled(t("forge.params.base_model"), mkBaseModelInput(render, refreshNativeContext)));
  card.appendChild(labeled(t("forge.params.context"), mkContextEmbedded()));

  const yarnSection = buildYarnSection();
  const vramSection = buildVramSection();
  card.appendChild(yarnSection.node);
  card.appendChild(vramSection.node);
  card.appendChild(buildAdvancedDetails(yarnSection.refresh, vramSection.refresh));

  STATE._refreshSecondary = () => {
    yarnSection.refresh();
    vramSection.refresh();
  };
  return card;
}

/** @param {() => void} render */
function buildPresetsRow(render) {
  const row = el("div", { class: "forge-quality" });
  for (const id of ["basic", "quality", "yarn"]) {
    const btn = el("button", { class: "forge-quality-card", type: "button", "data-id": id }, [
      el("div", { class: "forge-quality-title" }, t(`forge.params.preset.${id}`)),
      el("div", { class: "forge-quality-meta" }, t(`forge.params.preset.${id}.meta`)),
    ]);
    btn.addEventListener("click", () => {
      Object.assign(STATE.spec, PRESETS_BY_QUALITY[id]);
      STATE.yarnSuggestShown = false;
      render();
    });
    row.appendChild(btn);
  }
  return row;
}

/**
 * @param {() => void} render
 * @param {() => Promise<void>} refreshNativeContext
 */
function mkBaseModelInput(render, refreshNativeContext) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "text", class: "forge-input",
    value: String(STATE.spec.baseModel ?? ""),
  }));
  input.addEventListener("input", () => {
    STATE.spec.baseModel = input.value;
  });
  input.addEventListener("change", () => {
    void refreshNativeContext().then(() => render());
  });
  return input;
}

function mkContextEmbedded() {
  const wrap = el("div", { class: "forge-ctx-wrap" });
  const slider = buildContextSlider({
    modelKey: STATE.spec.baseModel,
    mode: "embedded",
    initialTokens: STATE.spec.maxSeqLength,
    onChange: (target) => {
      STATE.spec.maxSeqLength = target;
      maybeAutoSuggestYarn();
      if (STATE._refreshSecondary) STATE._refreshSecondary();
    },
  });
  wrap.appendChild(slider);
  return wrap;
}

function maybeAutoSuggestYarn() {
  if (STATE.yarnSuggestShown) return;
  if (!STATE.nativeContext) return;
  if (STATE.spec.useYarn) return;
  if (STATE.spec.maxSeqLength <= STATE.nativeContext) return;
  STATE.yarnSuggestShown = true;
  showToast(t("forge.yarn.suggest.toast"), "warn");
}

function buildYarnSection() {
  const node = el("div", { class: "forge-section" });
  node.appendChild(el("div", { class: "forge-section-title" }, t("forge.params.yarn_section")));

  const toggleRow = el("label", { class: "forge-yarn-toggle" });
  const toggle = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox" }));
  toggle.checked = !!STATE.spec.useYarn;
  toggle.addEventListener("change", () => {
    STATE.spec.useYarn = toggle.checked;
    if (toggle.checked && STATE.spec.yarnFactor <= 1 && STATE.nativeContext) {
      STATE.spec.yarnFactor = Math.max(1, Math.ceil(STATE.spec.maxSeqLength / STATE.nativeContext));
    }
    refresh();
    if (STATE._refreshSecondary) STATE._refreshSecondary();
  });
  toggleRow.appendChild(toggle);
  toggleRow.appendChild(el("span", {}, t("forge.yarn.toggle.label")));
  node.appendChild(toggleRow);

  const explain = el("div", { class: "forge-yarn-explain" });
  node.appendChild(explain);

  const factorRow = el("div", { class: "forge-yarn-factor-row" });
  const factorInput = /** @type {HTMLInputElement} */ (el("input", {
    type: "number", min: "1", max: "8", step: "0.5",
    value: String(STATE.spec.yarnFactor),
  }));
  factorInput.addEventListener("input", () => {
    const v = Number(factorInput.value);
    if (Number.isFinite(v) && v >= 1) {
      STATE.spec.yarnFactor = v;
      refresh();
    }
  });
  factorRow.appendChild(el("span", {}, t("forge.yarn.factor.label")));
  factorRow.appendChild(factorInput);
  node.appendChild(factorRow);

  function refresh() {
    explain.classList.remove("forge-yarn-warn", "forge-yarn-ok");
    factorInput.value = String(STATE.spec.yarnFactor);
    factorRow.style.display = STATE.spec.useYarn ? "flex" : "none";

    const native = STATE.nativeContext;
    const ctx = STATE.spec.maxSeqLength;
    if (STATE.spec.useYarn) {
      explain.textContent = t("forge.yarn.on", { factor: STATE.spec.yarnFactor });
      explain.classList.add("forge-yarn-ok");
    } else if (native && ctx > native) {
      explain.textContent = t("forge.yarn.off.long_ctx_warn");
      explain.classList.add("forge-yarn-warn");
    } else {
      explain.textContent = t("forge.yarn.off.short_ctx");
    }
  }
  refresh();

  return { node, refresh };
}

function buildVramSection() {
  const node = el("div", { class: "forge-section" });
  node.appendChild(el("div", { class: "forge-section-title" }, t("forge.params.vram_section")));
  const calc = buildVramCalculator(currentVramOpts());
  node.appendChild(calc);
  function refresh() {
    /** @type {any} */ (calc).update(currentVramOpts());
  }
  return { node, refresh };
}

function currentVramOpts() {
  const params = guessParamsFromName(STATE.spec.baseModel);
  return {
    model: { params },
    mode: STATE.spec.method === "full"
      ? "full"
      : STATE.spec.method === "qlora"
        ? "qlora"
        : "lora",
    quant: STATE.spec.quantization === "int4"
      ? "q4_0"
      : STATE.spec.quantization === "int8"
        ? "q8_0"
        : "fp16",
    contextTokens: STATE.spec.maxSeqLength,
    hardware: {},
  };
}

function buildAdvancedDetails(refreshYarn, refreshVram) {
  const grid = el("div", { class: "forge-advanced" }, [
    labeled("LoRA r", mkNumber("loraR", 4, 128, 1)),
    labeled("LoRA α", mkNumber("loraAlpha", 4, 256, 1)),
    labeled("Dropout", mkNumber("loraDropout", 0, 0.5, 0.01)),
    labeled("DoRA", mkCheck("useDora")),
    labeled("LR", mkNumber("learningRate", 0.000001, 0.001, 0.00001)),
    labeled("Epochs", mkNumber("numEpochs", 1, 20, 1)),
    labeled("Batch", mkNumber("perDeviceBatchSize", 1, 64, 1)),
    labeled("Grad accum", mkNumber("gradientAccumulation", 1, 64, 1)),
    labeled("Warmup ratio", mkNumber("warmupRatio", 0, 0.5, 0.01)),
    labeled("Weight decay", mkNumber("weightDecay", 0, 0.5, 0.01)),
    labeled("Method", mkSelect("method", ["qlora", "lora", "dora", "full"], () => {
      refreshVram();
    })),
    labeled("Quant", mkSelect("quantization", ["int4", "int8", "bf16", "fp16"], () => {
      refreshVram();
    })),
  ]);
  return el("details", { class: "forge-collapsible" }, [
    el("summary", { class: "forge-collapsible-summary" }, t("forge.params.advanced_section")),
    el("div", { class: "forge-collapsible-body" }, [grid]),
  ]);
}
