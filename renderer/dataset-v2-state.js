// @ts-check
/**
 * Shared state + helpers для UI «Создание датасета» (Crystal).
 *
 * Извлечено из `renderer/dataset-v2.js` (Phase 3.4 cross-platform roadmap,
 * 2026-04-30). Mutable singleton — один STATE на всё mounting окно.
 */

import { t } from "./i18n.js";

export const STATE = {
  collection: "delta-knowledge",
  pairsPerConcept: 2,
  /** @type {"sharegpt" | "chatml"} */
  format: "chatml",
  outputDir: "",
  busy: false,
  /** @type {"idle" | "synth"} */
  mode: "idle",
  /** @type {null | {concepts: number; totalLines: number; trainLines: number; valLines: number; outputDir: string; format: string; files: string[]; byDomain: Record<string, number>; method?: string; model?: string; durationMs?: number; llmFailures?: number; schemaFailures?: number; rawSamples?: Array<{conceptId: string; reason: string; raw: string}>}} */
  result: null,
  /** @type {string | null} */
  lastError: null,
  synthProgress: {
    phase: /** @type {"idle"|"scan"|"generate"|"write"|"done"|"error"} */ ("idle"),
    conceptsRead: 0,
    paired: 0,
    skippedEmpty: 0,
    skippedLlmFail: 0,
    skippedSchemaFail: 0,
    /** @type {string | null} */
    currentDomain: null,
    /** @type {string | null} */
    currentEssence: null,
  },
  synth: {
    /** @type {string | null} */
    currentJobId: null,
  },
  showAdvanced: false,
  /**
   * Runtime-only refs на DOM-компоненты. Wizard заполняет, action читает —
   * чтобы избежать передачи синглтонов через все 4 step builder'ов.
   */
  refs: {
    /** @type {ReturnType<import("./components/model-select.js")["buildModelSelect"]> | null} */
    synthModelSelect: null,
    /** @type {ReturnType<import("./components/collection-picker.js")["buildCollectionPicker"]> | null} */
    collectionPicker: null,
  },
};

export const SYNTH_MODEL_HINTS = ["qwen3.6", "qwen3-coder", "qwen2.5", "mistral-small", "gemma-3"];

export function phaseToLabel(phase) {
  switch (phase) {
    case "scan":
      return t("dataset.synth.phase.scan");
    case "generate":
      return t("dataset.synth.phase.generate");
    case "write":
      return t("dataset.synth.phase.write");
    case "done":
      return t("dataset.synth.phase.done");
    default:
      return t("dataset.synth.phase.idle");
  }
}

export function isCrystalBusy() {
  return STATE.busy;
}
