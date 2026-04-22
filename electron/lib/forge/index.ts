export {
  shareGptToChatML,
  chatMLToShareGPT,
  detectFormat,
  parseAsChatML,
  chatMLLinesToJsonl,
  splitLines,
  ShareGPTLineSchema,
  ChatMLLineSchema,
  type ShareGPTLine,
  type ChatMLLine,
  type DatasetFormat,
  type SplitOptions,
  type SplitResult,
} from "./format";

export {
  generateUnslothPython,
  generateAxolotlYaml,
  generateBundleReadme,
  ForgeSpecSchema,
  type ForgeSpec,
} from "./configgen";

export {
  initForgeStore,
  getForgeStore,
  registerForgePipeline,
  nextForgeRunId,
  ForgeRunStateSchema,
  type ForgeRunState,
} from "./state";

export {
  prepareDataset,
  generateBundle,
  type PrepareResult,
} from "./pipeline";

export {
  detectWSL,
  spawnWsl,
  toWslPath,
  type WslInfo,
} from "./wsl";

export {
  LocalRunner,
  parseMetric,
  importGgufToLMStudio,
  type TrainingMetric,
} from "./local-runner";

/* AUDIT (Inquisitor): judgeOne больше не реэкспортируется — он используется
   только внутри runEval; внешних импортёров нет (grep confirmed). Если
   когда-нибудь понадобится отдельный judge-API, вернём через barrel. */
export {
  rougeL,
  runEval,
  chatMLToEvalCases,
  type RougeScore,
  type EvalCase,
  type EvalResult,
  type EvalSummary,
  type EvalChatFn,
} from "./eval-harness";
