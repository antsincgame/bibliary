// @ts-check
/**
 * Forge wizard v2.4 (self-hosted-only, 3-step):
 *   Step 0 — Подготовка (источник + опционально advanced split)
 *   Step 1 — Параметры (3 пресета + base model + ctx slider + YaRN секция + VRAM + Advanced)
 *   Step 2 — Локальный Workspace (генерация файлов для запуска на своём железе)
 *
 * Облачные target'ы (Colab/AutoTrain) и HF token widget удалены при переходе
 * на 100% self-hosted философию. Backward compat: старые сериализованные
 * STATE с полем `target` молча игнорируются (Zod default strip).
 */
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildContextSlider } from "./components/context-slider.js";
import { buildVramCalculator } from "./components/vram-calc.js";
import { buildEvalPanel } from "./components/eval-panel.js";
import { buildNeonHero, neonDivider } from "./components/neon-helpers.js";

const TOAST_TTL_MS = 5000;
const STEP_KEYS = ["forge.step.prepare", "forge.step.params", "forge.step.run"];
const LAST_STEP = STEP_KEYS.length - 1;

const STATE = {
  step: 0,
  /** @type {string|null} */ runId: null,
  /** @type {string|null} */ sourcePath: null,
  /** @type {any} */ preview: null,
  /** @type {any} */ prepareResult: null,
  /** @type {any} */ spec: defaultSpec(),
  trainRatio: 0.9,
  evalRatio: 0.05,
  /** @type {number|null} */ nativeContext: null,
  yarnSuggestShown: false,
  /** @type {string|null} */ bundleDir: null,
  localRun: defaultLocalRun(),
};

function defaultLocalRun() {
  return {
    /** @type {string|null} */ runId: null,
    /** @type {"idle"|"running"|"succeeded"|"failed"|"cancelled"} */ status: "idle",
    /** @type {{step:number,loss?:number,gradNorm?:number,learningRate?:number,epoch?:number}|null} */ metric: null,
    /** @type {string[]} */ stdoutTail: [],
    /** @type {number|null} */ exitCode: null,
    /** @type {string|null} */ error: null,
    /** @type {Array<()=>void>} */ unsubs: [],
    importedGguf: false,
    /** @type {(()=>void)|null} */ refresh: null,
  };
}

const STDOUT_TAIL_MAX = 200;

/** Module-level lock против двойных кликов на «Запустить в WSL» в окне между
 *  кликом и переходом status → "running". Без этого пользователь успевает
 *  запустить два параллельных wsl.detect → start. */
let _startingLocalRun = false;

function cleanupLocalListeners() {
  if (!STATE.localRun) return;
  for (const off of STATE.localRun.unsubs) {
    try { off(); } catch { /* listener detach should never throw, but guard anyway */ }
  }
  STATE.localRun.unsubs = [];
  // ВАЖНО: refresh НЕ обнуляем — это closure на DOM-узел buildLocalRunSection,
  // который остаётся mounted. Если обнулить — все последующие onMetric/onStdout/
  // onExit/onError вызовы STATE.localRun.refresh() станут no-op, и UI замрёт
  // в "idle" пока тренировка идёт в WSL. См. UI-tester audit от 2026-04-22.
}

/** Сбрасывает рабочие поля localRun in-place, сохраняя refresh-замыкание. */
function resetLocalRunFields() {
  cleanupLocalListeners();
  STATE.localRun.runId = null;
  STATE.localRun.status = "idle";
  STATE.localRun.metric = null;
  STATE.localRun.stdoutTail = [];
  STATE.localRun.exitCode = null;
  STATE.localRun.error = null;
  STATE.localRun.importedGguf = false;
}

function resetLocalRun() {
  resetLocalRunFields();
}

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
    exportGguf: true,
    useYarn: false,
    yarnFactor: 1.0,
    /** @type {number|undefined} */ nativeContextLength: undefined,
  };
}

/**
 * Self-hosted-friendly пресеты (v2.4):
 *   - basic   — быстрый знакомый прогон, дефолт
 *   - quality — лучший adapter, долго (8 эпох, ctx 16K, bf16, r=128)
 *   - yarn    — YaRN ×4 → ctx 131K для книг/codebase/юр-корпусов
 */
const PRESETS_BY_QUALITY = {
  basic: {
    method: "qlora", loraR: 32, loraAlpha: 64, useDora: true,
    learningRate: 0.0001, numEpochs: 3, perDeviceBatchSize: 2, gradientAccumulation: 4,
    maxSeqLength: 8192, useYarn: false, yarnFactor: 1.0, quantization: "int4",
  },
  quality: {
    method: "lora", loraR: 128, loraAlpha: 256, useDora: true,
    learningRate: 0.00003, numEpochs: 8, perDeviceBatchSize: 1, gradientAccumulation: 8,
    maxSeqLength: 16384, useYarn: false, yarnFactor: 1.0, quantization: "bf16",
  },
  yarn: {
    method: "qlora", loraR: 32, loraAlpha: 64, useDora: true,
    learningRate: 0.0001, numEpochs: 4, perDeviceBatchSize: 1, gradientAccumulation: 4,
    maxSeqLength: 131072, useYarn: true, yarnFactor: 4.0, quantization: "int4",
  },
};

let pageRoot = null;

export function mountForge(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  pageRoot = root;
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

/**
 * Подгружает родное окно контекста для текущей baseModel из yarn engine.
 * Используется YaRN-секцией и VRAM-калькулятором.
 */
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
  if (STATE.step === 0) pageRoot.appendChild(buildStepPrepare());
  else if (STATE.step === 1) pageRoot.appendChild(buildStepParamsLocal());
  else if (STATE.step === 2) pageRoot.appendChild(buildStepRunMinimal());
  pageRoot.appendChild(buildFooter());
}

function buildStepper() {
  const wrap = el("div", { class: "forge-stepper", role: "tablist" });
  STEP_KEYS.forEach((key, i) => {
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

// ─── Step 0: Prepare (Source + Format collapsed) ───────────────────────────

function buildStepPrepare() {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.source.title")),
    el("div", { class: "card-sub" }, t("forge.source.sub")),
  ]);
  card.appendChild(buildSourceList());
  if (STATE.preview) card.appendChild(buildSourcePreview());
  card.appendChild(buildPrepareSection());
  card.appendChild(buildAdvancedSplitDetails());
  if (STATE.prepareResult) card.appendChild(buildPrepareResult());
  return card;
}

function buildSourceList() {
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

function buildPrepareSection() {
  const prepareBtn = el("button", { class: "btn btn-gold", type: "button" }, t("forge.format.prepare"));
  prepareBtn.addEventListener("click", () => void runPrepare(prepareBtn));
  return prepareBtn;
}

async function runPrepare(prepareBtn) {
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

// ─── Step 1: Params (presets + ctx + YaRN + VRAM + Advanced) ───────────────

function buildStepParamsLocal() {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.params.title")),
    el("div", { class: "card-sub" }, t("forge.params.sub")),
  ]);
  card.appendChild(buildPresetsRow());
  card.appendChild(labeled(t("forge.params.base_model"), mkBaseModelInput()));
  card.appendChild(labeled(t("forge.params.context"), mkContextEmbedded()));

  const yarnSection = buildYarnSection();
  const vramSection = buildVramSection();
  card.appendChild(yarnSection.node);
  card.appendChild(vramSection.node);
  card.appendChild(buildAdvancedDetails(yarnSection.refresh, vramSection.refresh));

  // Связываем context-slider onChange с YaRN/VRAM live refresh
  STATE._refreshSecondary = () => {
    yarnSection.refresh();
    vramSection.refresh();
  };
  return card;
}

function buildPresetsRow() {
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

function mkBaseModelInput() {
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

// ── YaRN section (звезда Step 1) ───────────────────────────────────────────

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

// ── VRAM section ───────────────────────────────────────────────────────────

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

// ── Advanced (collapsed) ───────────────────────────────────────────────────

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

// ─── Step 2: Workspace (was Run) ───────────────────────────────────────────

function buildStepRunMinimal() {
  const card = el("div", { class: "card forge-card" }, [
    el("div", { class: "card-title" }, t("forge.run.workspace.title")),
    el("div", { class: "card-sub" }, t("forge.run.workspace.sub")),
  ]);
  card.appendChild(buildRunSummary());
  card.appendChild(buildWorkspaceActions());
  card.appendChild(buildLocalRunSection());
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

function buildWorkspaceActions() {
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
  } catch {
    /* clipboard может быть запрещён — ничего не делаем, пользователь увидит путь в UI */
  }
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
  if (STATE.step < LAST_STEP) {
    const next = el("button", { class: "btn btn-gold", type: "button" }, t("forge.next"));
    next.addEventListener("click", () => {
      if (STATE.step === 0 && !STATE.prepareResult) {
        showToast(t("forge.toast.prepare_first_unified"), "error");
        return;
      }
      STATE.step++;
      render();
    });
    wrap.appendChild(next);
  }
  return wrap;
}

// ─── Step 3: Local Run (LocalRunner UI hook) ───────────────────────────────

/**
 * Inline-секция с live-стримом тренировки в WSL. Появляется только когда
 * Workspace уже сгенерирован (есть STATE.bundleDir). Все обновления —
 * точечные через STATE.localRun.refresh(), без полного render(), чтобы
 * не порвать stdout-tail и не сжечь CPU при метриках 1-2 раза в секунду.
 */
function buildLocalRunSection() {
  const wrap = el("div", { class: "forge-section forge-local-run" });
  STATE.localRun.refresh = () => renderInto(wrap);
  renderInto(wrap);
  return wrap;

  function renderInto(node) {
    clear(node);
    node.appendChild(el("div", { class: "forge-section-title" }, t("forge.local.section.title")));
    node.appendChild(el("div", { class: "forge-section-sub" }, t("forge.local.section.sub")));

    if (!STATE.bundleDir) {
      node.appendChild(el("div", { class: "forge-local-hint" }, t("forge.local.hint.generate_first")));
      return;
    }

    const lr = STATE.localRun;
    if (lr.status === "idle") {
      const startBtn = /** @type {HTMLButtonElement} */ (el("button", {
        class: "btn btn-gold", type: "button",
      }, _startingLocalRun ? t("forge.local.btn.starting") : t("forge.local.btn.start")));
      if (_startingLocalRun) startBtn.disabled = true;
      startBtn.addEventListener("click", () => void startLocalRun());
      node.appendChild(startBtn);
      node.appendChild(el("div", { class: "forge-local-hint" }, t("forge.local.hint.requirements")));
      return;
    }

    if (lr.status === "running") {
      node.appendChild(buildStatusBadge("running", t("forge.local.status.running")));
      node.appendChild(buildMetricGrid(lr.metric));
      node.appendChild(buildStdoutTail(lr.stdoutTail));
      const cancelBtn = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.local.btn.cancel"));
      cancelBtn.addEventListener("click", () => void cancelLocalRun());
      node.appendChild(cancelBtn);
      return;
    }

    if (lr.status === "succeeded") {
      node.appendChild(buildStatusBadge("succeeded", t("forge.local.status.succeeded")));
      node.appendChild(buildMetricGrid(lr.metric));
      node.appendChild(buildStdoutTail(lr.stdoutTail));
      const actions = el("div", { class: "forge-local-actions" });
      const importBtn = /** @type {HTMLButtonElement} */ (el("button", {
        class: "btn btn-gold", type: "button",
      }, importBtnLabel(lr.importedGguf, _importingGguf)));
      if (lr.importedGguf || _importingGguf) importBtn.disabled = true;
      importBtn.addEventListener("click", () => void importGgufClick());
      actions.appendChild(importBtn);
      const resetBtn = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.local.btn.reset"));
      resetBtn.addEventListener("click", () => { resetLocalRun(); render(); });
      actions.appendChild(resetBtn);
      node.appendChild(actions);
      return;
    }

    if (lr.status === "failed" || lr.status === "cancelled") {
      const code = lr.exitCode == null ? "?" : String(lr.exitCode);
      const label = lr.status === "cancelled"
        ? t("forge.local.status.cancelled")
        : t("forge.local.status.failed", { code });
      node.appendChild(buildStatusBadge(lr.status, label));
      if (lr.error) node.appendChild(el("div", { class: "forge-local-error" }, lr.error));
      node.appendChild(buildStdoutTail(lr.stdoutTail));
      const resetBtn = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.local.btn.reset"));
      resetBtn.addEventListener("click", () => { resetLocalRun(); render(); });
      node.appendChild(resetBtn);
    }
  }
}

function buildStatusBadge(kind, label) {
  return el("div", { class: `forge-local-badge forge-local-badge-${kind}` }, label);
}

function importBtnLabel(done, busy) {
  if (done) return t("forge.local.btn.gguf_done");
  if (busy) return t("forge.local.btn.gguf_busy");
  return t("forge.local.btn.import_gguf");
}

function buildMetricGrid(metric) {
  const grid = el("div", { class: "forge-metric-grid" });
  const cells = [
    ["forge.local.metric.step", metric?.step != null ? String(metric.step) : "—"],
    ["forge.local.metric.loss", metric?.loss != null ? metric.loss.toFixed(4) : "—"],
    ["forge.local.metric.grad_norm", metric?.gradNorm != null ? metric.gradNorm.toFixed(4) : "—"],
    ["forge.local.metric.lr", metric?.learningRate != null ? metric.learningRate.toExponential(2) : "—"],
    ["forge.local.metric.epoch", metric?.epoch != null ? metric.epoch.toFixed(2) : "—"],
  ];
  for (const [key, value] of cells) {
    grid.appendChild(el("div", { class: "forge-metric-cell" }, [
      el("div", { class: "forge-metric-label" }, t(key)),
      el("div", { class: "forge-metric-value" }, value),
    ]));
  }
  return grid;
}

function buildStdoutTail(tail) {
  const body = el("pre", { class: "forge-stdout-tail" }, tail.length === 0 ? "" : tail.join("\n"));
  return el("details", { class: "forge-collapsible" }, [
    el("summary", { class: "forge-collapsible-summary" }, `${t("forge.local.stdout")} (${tail.length})`),
    body,
  ]);
}

async function startLocalRun() {
  if (_startingLocalRun || STATE.localRun.status === "running") return;
  if (!STATE.bundleDir) {
    showToast(t("forge.local.toast.no_workspace"), "error");
    return;
  }
  _startingLocalRun = true;
  try {
    const wsl = /** @type {any} */ (await window.api.wsl.detect().catch(() => null));
    if (!wsl || !wsl.installed) {
      showToast(t("forge.local.toast.no_wsl"), "error");
      return;
    }
    if (!wsl.gpuPassthrough) {
      showToast(t("forge.local.toast.no_gpu"), "warn");
    }

    resetLocalRunFields();
    const runId = STATE.spec.runId;
    STATE.localRun.runId = runId;
    STATE.localRun.status = "running";
    if (STATE.localRun.refresh) STATE.localRun.refresh();

    const onMetric = window.api.forgeLocal.onMetric(({ runId: r, metric }) => {
      if (r !== STATE.localRun.runId) return;
      STATE.localRun.metric = /** @type {any} */ (metric);
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    });
    const onStdout = window.api.forgeLocal.onStdout(({ runId: r, line }) => {
      if (r !== STATE.localRun.runId) return;
      pushStdoutLine(line);
    });
    const onStderr = window.api.forgeLocal.onStderr(({ runId: r, line }) => {
      if (r !== STATE.localRun.runId) return;
      pushStdoutLine(`[stderr] ${line}`);
    });
    const onExit = window.api.forgeLocal.onExit(({ runId: r, code }) => {
      if (r !== STATE.localRun.runId) return;
      STATE.localRun.exitCode = code;
      STATE.localRun.status = code === 0 ? "succeeded" : "failed";
      cleanupLocalListenersKeepData();
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    });
    const onError = window.api.forgeLocal.onError(({ runId: r, error }) => {
      if (r !== STATE.localRun.runId) return;
      STATE.localRun.error = error;
      STATE.localRun.status = "failed";
      cleanupLocalListenersKeepData();
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    });
    STATE.localRun.unsubs = [onMetric, onStdout, onStderr, onExit, onError];

    const scriptWinPath = `${STATE.bundleDir}\\${runId}.py`;
    try {
      await window.api.forgeLocal.start({ runId, scriptWinPath });
    } catch (e) {
      cleanupLocalListenersKeepData();
      STATE.localRun.status = "failed";
      STATE.localRun.error = errMsg(e);
      showToast(t("forge.local.toast.start_fail", { msg: errMsg(e) }), "error");
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    }
  } finally {
    _startingLocalRun = false;
  }
}

function pushStdoutLine(line) {
  STATE.localRun.stdoutTail.push(line);
  if (STATE.localRun.stdoutTail.length > STDOUT_TAIL_MAX) {
    STATE.localRun.stdoutTail.splice(0, STATE.localRun.stdoutTail.length - STDOUT_TAIL_MAX);
  }
  if (STATE.localRun.refresh) STATE.localRun.refresh();
}

/** Снимает event-listeners, но сохраняет stdoutTail / metric / exitCode для отображения. */
function cleanupLocalListenersKeepData() {
  for (const off of STATE.localRun.unsubs) {
    try { off(); } catch { /* see cleanupLocalListeners */ }
  }
  STATE.localRun.unsubs = [];
}

async function cancelLocalRun() {
  const runId = STATE.localRun.runId;
  if (!runId) return;
  try {
    const ok = await window.api.forgeLocal.cancel(runId);
    if (ok) {
      STATE.localRun.status = "cancelled";
      cleanupLocalListenersKeepData();
      showToast(t("forge.local.toast.cancelled"), "warn");
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    }
  } catch (e) {
    showToast(t("forge.local.toast.cancel_fail", { msg: errMsg(e) }), "error");
  }
}

let _importingGguf = false;

async function importGgufClick() {
  if (_importingGguf) return;
  if (!STATE.bundleDir) return;
  _importingGguf = true;
  if (STATE.localRun.refresh) STATE.localRun.refresh();
  const outputDir = `${STATE.bundleDir}\\${STATE.spec.runId}-output`;
  const modelKey = STATE.spec.runId;
  try {
    const result = /** @type {any} */ (await window.api.forgeLocal.importGguf(outputDir, modelKey));
    if (result.copied === 0) {
      showToast(t("forge.local.toast.gguf_none"), "warn");
      return;
    }
    STATE.localRun.importedGguf = true;
    showToast(t("forge.local.toast.gguf_imported", { count: result.copied, path: result.destPath }), "success");
  } catch (e) {
    showToast(t("forge.local.toast.gguf_fail", { msg: errMsg(e) }), "error");
  } finally {
    _importingGguf = false;
    if (STATE.localRun.refresh) STATE.localRun.refresh();
  }
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

function mkSelect(key, options, onChange) {
  const select = /** @type {HTMLSelectElement} */ (el("select", { class: "forge-input" }));
  for (const opt of options) {
    const o = /** @type {HTMLOptionElement} */ (el("option", { value: opt }, opt));
    if (STATE.spec[key] === opt) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => {
    STATE.spec[key] = select.value;
    if (typeof onChange === "function") onChange();
  });
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
  const m = String(name || "").match(/(\d+(?:\.\d+)?)[bB]/);
  return m ? Number(m[1]) : 7;
}
