// @ts-check
/**
 * Forge wizard shared state singleton + defaults + lifecycle helpers.
 */

export const TOAST_TTL_MS = 5000;
export const STEP_KEYS = ["forge.step.prepare", "forge.step.params", "forge.step.run"];
export const LAST_STEP = STEP_KEYS.length - 1;
export const STDOUT_TAIL_MAX = 200;

export const PRESETS_BY_QUALITY = {
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

export function defaultLocalRun() {
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

export function defaultSpec() {
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

export const STATE = {
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
  /** @type {(()=>void)|null} */ _refreshSecondary: null,
};

/** @type {HTMLElement|null} */
export let pageRoot = null;

/** @param {HTMLElement|null} root */
export function setPageRoot(root) {
  pageRoot = root;
}

export let _startingLocalRun = false;
/** @param {boolean} v */
export function setStartingLocalRun(v) { _startingLocalRun = v; }

export let _importingGguf = false;
/** @param {boolean} v */
export function setImportingGguf(v) { _importingGguf = v; }

export function cleanupLocalListeners() {
  if (!STATE.localRun) return;
  for (const off of STATE.localRun.unsubs) {
    try { off(); } catch { /* guard */ }
  }
  STATE.localRun.unsubs = [];
}

export function resetLocalRunFields() {
  cleanupLocalListeners();
  STATE.localRun.runId = null;
  STATE.localRun.status = "idle";
  STATE.localRun.metric = null;
  STATE.localRun.stdoutTail = [];
  STATE.localRun.exitCode = null;
  STATE.localRun.error = null;
  STATE.localRun.importedGguf = false;
}

export function resetLocalRun() {
  resetLocalRunFields();
}

export function cleanupLocalListenersKeepData() {
  for (const off of STATE.localRun.unsubs) {
    try { off(); } catch { /* guard */ }
  }
  STATE.localRun.unsubs = [];
}

export function guessParamsFromName(name) {
  const m = String(name || "").match(/(\d+(?:\.\d+)?)[bB]/);
  return m ? Number(m[1]) : 7;
}
