// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildContextSlider } from "./components/context-slider.js";
import { buildVramCalculator } from "./components/vram-calc.js";
import { buildEvalPanel } from "./components/eval-panel.js";
import { buildNeonHero, neonDivider } from "./components/neon-helpers.js";

const TOAST_TTL_MS = 5000;

const STATE = {
  step: 0,
  /** @type {string|null} */ runId: null,
  /** @type {string|null} */ sourcePath: null,
  /** @type {any} */ preview: null,
  /** @type {any} */ prepareResult: null,
  /** @type {any} */ spec: defaultSpec(),
  trainRatio: 0.9,
  evalRatio: 0.05,
  /** @type {"colab"|"autotrain"|"local"|"bundle"} */ target: "colab",
};

function defaultSpec() {
  return {
    runId: "",
    baseModel: "unsloth/Qwen3-4B-Instruct-2507",
    method: "qlora",
    loraR: 16,
    loraAlpha: 32,
    loraDropout: 0.05,
    useDora: true,
    targetModules: ["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
    maxSeqLength: 2048,
    learningRate: 0.0002,
    numEpochs: 2,
    perDeviceBatchSize: 2,
    gradientAccumulation: 4,
    warmupRatio: 0.03,
    weightDecay: 0.01,
    scheduler: "cosine",
    optimizer: "adamw_8bit",
    datasetPath: "",
    outputDir: "out/forge-run",
    quantization: "int4",
    pushToHub: false,
    exportGguf: true,
  };
}

const PRESETS_BY_QUALITY = {
  fast: { method: "qlora", loraR: 16, loraAlpha: 32, useDora: true, learningRate: 0.0002, numEpochs: 2 },
  balanced: { method: "qlora", loraR: 32, loraAlpha: 64, useDora: true, learningRate: 0.0001, numEpochs: 3 },
  quality: { method: "lora", loraR: 64, loraAlpha: 128, useDora: true, learningRate: 0.00005, numEpochs: 5 },
};

let pageRoot = null;

export function mountForge(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  pageRoot = root;
  void initialize();
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
  render();
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
  if (STATE.step === 0) pageRoot.appendChild(buildStepSource());
  else if (STATE.step === 1) pageRoot.appendChild(buildStepFormat());
  else if (STATE.step === 2) pageRoot.appendChild(buildStepHyperparams());
  else if (STATE.step === 3) pageRoot.appendChild(buildStepTarget());
  else if (STATE.step === 4) pageRoot.appendChild(buildStepRun());
  pageRoot.appendChild(buildFooter());
}

function buildStepper() {
  const steps = ["forge.step.source", "forge.step.format", "forge.step.params", "forge.step.target", "forge.step.run"];
  const wrap = el("div", { class: "forge-stepper", role: "tablist" });
  steps.forEach((key, i) => {
    wrap.appendChild(
      el("div", {
        class: "forge-step-pill" +
          (i === STATE.step ? " forge-step-active" : "") +
          (i < STATE.step ? " forge-step-done" : ""),
        role: "tab",
        "aria-selected": i === STATE.step ? "true" : "false",
      }, [
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

// ─── Step 0: Source ────────────────────────────────────────────────────────

function buildStepSource() {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.source.title")),
    el("div", { class: "card-sub" }, t("forge.source.sub")),
  ]);
  const list = el("div", { class: "forge-source-list" });
  card.appendChild(list);

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
          el(
            "button",
            {
              class: "btn btn-ghost",
              type: "button",
            },
            t("forge.source.pick")
          ),
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

  if (STATE.preview) {
    card.appendChild(el("div", { class: "forge-preview" }, [
      el("div", { class: "forge-preview-title" }, t("forge.source.preview", { count: STATE.preview.total, errors: STATE.preview.errors })),
      el("pre", { class: "forge-preview-json" }, JSON.stringify(STATE.preview.sample, null, 2)),
    ]));
  }

  return card;
}

// ─── Step 1: Format & Split ────────────────────────────────────────────────

function buildStepFormat() {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.format.title")),
    el("div", { class: "card-sub" }, t("forge.format.sub")),
  ]);

  const trainSlider = mkRange("trainRatio", 0.7, 0.99, 0.01, STATE.trainRatio);
  trainSlider.input.addEventListener("input", () => {
    STATE.trainRatio = Number(trainSlider.input.value);
    trainSlider.label.textContent = `${Math.round(STATE.trainRatio * 100)}%`;
  });
  trainSlider.label.textContent = `${Math.round(STATE.trainRatio * 100)}%`;
  card.appendChild(labeled(t("forge.format.train_ratio"), trainSlider.wrap));

  const evalSlider = mkRange("evalRatio", 0, 0.3, 0.01, STATE.evalRatio);
  evalSlider.input.addEventListener("input", () => {
    STATE.evalRatio = Number(evalSlider.input.value);
    evalSlider.label.textContent = `${Math.round(STATE.evalRatio * 100)}%`;
  });
  evalSlider.label.textContent = `${Math.round(STATE.evalRatio * 100)}%`;
  card.appendChild(labeled(t("forge.format.eval_ratio"), evalSlider.wrap));

  const prepareBtn = el("button", { class: "btn btn-gold", type: "button" }, t("forge.format.prepare"));
  prepareBtn.addEventListener("click", async () => {
    if (!STATE.sourcePath) {
      showToast(t("forge.toast.no_source"), "error");
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
  });
  card.appendChild(prepareBtn);

  if (STATE.prepareResult) {
    card.appendChild(el("div", { class: "forge-preview" }, [
      el("div", { class: "forge-preview-title" }, t("forge.format.prepared")),
      el("ul", {}, [
        el("li", {}, `train: ${STATE.prepareResult.counts.train}`),
        el("li", {}, `val: ${STATE.prepareResult.counts.val}`),
        el("li", {}, `eval: ${STATE.prepareResult.counts.eval}`),
        el("li", {}, t("forge.format.errors", { n: STATE.prepareResult.parseErrors.length })),
      ]),
    ]));
  }

  return card;
}

// ─── Step 2: Hyperparams ───────────────────────────────────────────────────

function buildStepHyperparams() {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.params.title")),
    el("div", { class: "card-sub" }, t("forge.params.sub")),
  ]);

  // Quality presets (simple mode)
  const presetsRow = el("div", { class: "forge-quality" });
  for (const id of ["fast", "balanced", "quality"]) {
    const btn = el("button", { class: "forge-quality-card", type: "button", "data-id": id }, [
      el("div", { class: "forge-quality-title" }, t(`forge.params.preset.${id}`)),
      el("div", { class: "forge-quality-meta" }, t(`forge.params.preset.${id}.meta`)),
    ]);
    btn.addEventListener("click", () => {
      Object.assign(STATE.spec, PRESETS_BY_QUALITY[id]);
      render();
    });
    presetsRow.appendChild(btn);
  }
  card.appendChild(presetsRow);

  // Base model + max_seq_length (always visible)
  card.appendChild(labeled(t("forge.params.base_model"), mkText("baseModel")));
  card.appendChild(labeled(t("forge.params.context"), mkContextEmbedded()));

  // Advanced grid
  const adv = el("div", { class: "forge-advanced", "data-mode-min": "advanced" });
  adv.appendChild(labeled("LoRA r", mkNumber("loraR", 4, 128, 1)));
  adv.appendChild(labeled("LoRA α", mkNumber("loraAlpha", 4, 256, 1)));
  adv.appendChild(labeled("Dropout", mkNumber("loraDropout", 0, 0.5, 0.01)));
  adv.appendChild(labeled("DoRA", mkCheck("useDora")));
  adv.appendChild(labeled("LR", mkNumber("learningRate", 0.000001, 0.001, 0.00001)));
  adv.appendChild(labeled("Epochs", mkNumber("numEpochs", 1, 20, 1)));
  adv.appendChild(labeled("Batch", mkNumber("perDeviceBatchSize", 1, 64, 1)));
  adv.appendChild(labeled("Grad accum", mkNumber("gradientAccumulation", 1, 64, 1)));
  adv.appendChild(labeled("Warmup ratio", mkNumber("warmupRatio", 0, 0.5, 0.01)));
  adv.appendChild(labeled("Weight decay", mkNumber("weightDecay", 0, 0.5, 0.01)));
  adv.appendChild(labeled("Method", mkSelect("method", ["qlora", "lora", "dora", "full"])));
  adv.appendChild(labeled("Quant", mkSelect("quantization", ["int4", "int8", "bf16", "fp16"])));
  card.appendChild(adv);

  // VRAM calculator
  const params = guessParamsFromName(STATE.spec.baseModel);
  card.appendChild(buildVramCalculator({
    model: { params },
    mode: STATE.spec.method === "full" ? "full" : STATE.spec.method === "qlora" ? "qlora" : "lora",
    quant: STATE.spec.quantization === "int4" ? "q4_0" : STATE.spec.quantization === "int8" ? "q8_0" : "fp16",
    contextTokens: STATE.spec.maxSeqLength,
    hardware: {},
  }));

  return card;
}

function mkContextEmbedded() {
  // Используем context-slider в embedded режиме без apply
  const wrap = el("div", { class: "forge-ctx-wrap" });
  const slider = buildContextSlider({
    modelKey: STATE.spec.baseModel,
    mode: "embedded",
    initialTokens: STATE.spec.maxSeqLength,
    onChange: (target) => {
      STATE.spec.maxSeqLength = target;
    },
  });
  wrap.appendChild(slider);
  return wrap;
}

// ─── Step 3: Target ────────────────────────────────────────────────────────

function buildStepTarget() {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.target.title")),
    el("div", { class: "card-sub" }, t("forge.target.sub")),
  ]);

  const grid = el("div", { class: "forge-target-grid" });
  for (const id of ["colab", "autotrain", "bundle", "local"]) {
    const card2 = el("button", {
      class: "forge-target-card" + (STATE.target === id ? " forge-target-active" : ""),
      type: "button",
      "data-target": id,
    }, [
      el("div", { class: "forge-target-title" }, t(`forge.target.${id}.title`)),
      el("div", { class: "forge-target-desc" }, t(`forge.target.${id}.desc`)),
    ]);
    if (id === "local") {
      card2.classList.add("forge-target-disabled");
      card2.title = t("forge.target.local.disabled_hint");
    }
    card2.addEventListener("click", () => {
      if (id === "local") return; // Phase 3.3 enables this
      STATE.target = /** @type {any} */ (id);
      render();
    });
    grid.appendChild(card2);
  }
  card.appendChild(grid);
  return card;
}

// ─── Step 4: Run ───────────────────────────────────────────────────────────

function buildStepRun() {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.run.title")),
    el("div", { class: "card-sub" }, t("forge.run.sub")),
  ]);

  const summary = el("ul", { class: "forge-run-summary" }, [
    el("li", {}, `runId: ${STATE.spec.runId}`),
    el("li", {}, `target: ${STATE.target}`),
    el("li", {}, `model: ${STATE.spec.baseModel}`),
    el("li", {}, `method: ${STATE.spec.method.toUpperCase()} r=${STATE.spec.loraR} α=${STATE.spec.loraAlpha}`),
    el("li", {}, `context: ${STATE.spec.maxSeqLength}`),
    el("li", {}, `dataset: ${STATE.spec.datasetPath}`),
  ]);
  card.appendChild(summary);

  const goBtn = el("button", { class: "btn btn-gold", type: "button" }, t("forge.run.bundle"));
  goBtn.addEventListener("click", async () => {
    goBtn.disabled = true;
    try {
      const result = /** @type {any} */ (await window.api.forge.generateBundle({
        spec: STATE.spec,
        runId: STATE.spec.runId,
        target: STATE.target,
      }));
      showToast(t("forge.toast.bundle_ok", { dir: result.bundleDir }), "success");
      // Авто-открыть target
      if (STATE.target === "colab") await window.api.hf.openColab();
      else if (STATE.target === "autotrain") await window.api.hf.openAutoTrain();
    } catch (e) {
      showToast(t("forge.toast.bundle_fail", { msg: errMsg(e) }), "error");
    } finally {
      goBtn.disabled = false;
    }
  });
  card.appendChild(goBtn);

  const openBtn = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.run.open_folder"));
  openBtn.addEventListener("click", async () => {
    try {
      await window.api.forge.openBundleFolder(STATE.spec.runId);
    } catch (e) {
      showToast(t("forge.toast.open_fail", { msg: errMsg(e) }), "error");
    }
  });
  card.appendChild(openBtn);

  // Eval panel (только если есть подготовленный eval-set, Pro mode)
  if (STATE.prepareResult?.evalPath) {
    const evalSection = el("div", { class: "forge-eval-section", "data-mode-min": "pro" }, [
      el("div", { class: "card-title" }, t("eval.title")),
      el("div", { class: "card-sub" }, t("eval.sub")),
    ]);
    evalSection.appendChild(
      buildEvalPanel({
        evalPath: STATE.prepareResult.evalPath,
        baseModelDefault: STATE.spec.baseModel,
        tunedModelDefault: `bibliary-finetuned/${STATE.spec.runId}`,
      })
    );
    card.appendChild(evalSection);
  }

  const markRow = el("div", { class: "forge-mark-row" });
  for (const status of ["succeeded", "failed", "cancelled"]) {
    const b = el("button", { class: "btn btn-ghost", type: "button" }, t(`forge.run.mark.${status}`));
    b.addEventListener("click", async () => {
      try {
        await window.api.forge.markStatus(STATE.spec.runId, status);
        showToast(t("forge.toast.marked", { status }), "success");
      } catch (e) {
        showToast(t("forge.toast.mark_fail", { msg: errMsg(e) }), "error");
      }
    });
    markRow.appendChild(b);
  }
  card.appendChild(markRow);

  return card;
}

// ─── Footer ────────────────────────────────────────────────────────────────

function buildFooter() {
  const wrap = el("div", { class: "forge-footer" });
  if (STATE.step > 0) {
    const back = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.back"));
    back.addEventListener("click", () => {
      STATE.step--;
      render();
    });
    wrap.appendChild(back);
  }
  if (STATE.step < 4) {
    const next = el("button", { class: "btn btn-gold", type: "button" }, t("forge.next"));
    next.addEventListener("click", () => {
      if (STATE.step === 0 && !STATE.preview) {
        showToast(t("forge.toast.pick_source"), "error");
        return;
      }
      if (STATE.step === 1 && !STATE.prepareResult) {
        showToast(t("forge.toast.prepare_first"), "error");
        return;
      }
      STATE.step++;
      render();
    });
    wrap.appendChild(next);
  }
  return wrap;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function showToast(text, kind = "success") {
  if (!pageRoot) return;
  const area = pageRoot.querySelector("#forge-toast-area");
  if (!area) return;
  const node = el("div", { class: `chat-toast chat-toast-${kind}` }, text);
  area.appendChild(node);
  setTimeout(() => node.remove(), TOAST_TTL_MS);
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

function labeled(label, control) {
  return el("div", { class: "forge-field" }, [
    el("label", { class: "forge-field-label" }, label),
    control,
  ]);
}

function mkText(key) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "text",
    class: "forge-input",
    value: String(STATE.spec[key] ?? ""),
  }));
  input.addEventListener("input", () => { STATE.spec[key] = input.value; });
  return input;
}

function mkNumber(key, min, max, step) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "number",
    class: "forge-input",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(STATE.spec[key] ?? min),
  }));
  input.addEventListener("input", () => { STATE.spec[key] = Number(input.value); });
  return input;
}

function mkCheck(key) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    class: "forge-check",
  }));
  input.checked = !!STATE.spec[key];
  input.addEventListener("change", () => { STATE.spec[key] = input.checked; });
  return input;
}

function mkSelect(key, options) {
  const select = /** @type {HTMLSelectElement} */ (el("select", { class: "forge-input" }));
  for (const opt of options) {
    const o = /** @type {HTMLOptionElement} */ (el("option", { value: opt }, opt));
    if (STATE.spec[key] === opt) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => { STATE.spec[key] = select.value; });
  return select;
}

function mkRange(key, min, max, step, value) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "range",
    class: "forge-range",
    min: String(min), max: String(max), step: String(step),
    value: String(value),
  }));
  const label = el("span", { class: "forge-range-label" }, "");
  return { input, label, wrap: el("div", { class: "forge-range-wrap" }, [input, label]) };
}

function guessParamsFromName(name) {
  const m = name.match(/(\d+(?:\.\d+)?)[bB]/);
  return m ? Number(m[1]) : 7;
}
