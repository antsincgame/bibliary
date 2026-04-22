/**
 * Context Expansion (YaRN) — barrel.
 *
 * См. docs/CONTEXT-EXPANSION.md и план Phase 3.0.
 */

export {
  getModelArch,
  listKnownModels,
  computeRopeScaling,
  isYarnNeeded,
  estimateKVCache,
  recommendKVDtype,
  recommend,
  presetForTokens,
  TASK_PRESETS,
  type ModelArch,
  type KVDtype,
  type KVCacheEstimate,
  type RopeScalingConfig,
  type ContextRecommendation,
  type RecommendOptions,
  type TaskPreset,
} from "./engine";

export {
  applyRopeScaling,
  revertRopeScaling,
  readCurrentRopeScaling,
  hasActivePatch,
  hasBackup,
  resolveModelDir,
  resolveConfigPath,
  resolveBackupPath,
  getLMStudioModelsRoot,
  type PatchResult,
  type RevertResult,
} from "./lmstudio-patcher";

export {
  buildSuggestions,
  type Suggestion,
  type SuggestionAction,
  type SuggestionContext,
  type SuggestionSeverity,
} from "./suggestions";
