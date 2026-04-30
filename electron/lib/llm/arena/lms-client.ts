/**
 * LM Studio client for Olympics — barrel re-export.
 *
 * Файл сохранён как точка входа для обратной совместимости с тестами и
 * существующими потребителями (`olympics.ts`, arena ipc, и т.д.). Реальная
 * реализация разнесена на три модуля по ответственности:
 *
 *   - `lms-client-types.ts` — общие типы + `makeLogger`
 *   - `lms-client-rest.ts`  — REST API: list / load / unload / health / chat
 *   - `lms-client-sdk.ts`   — SDK route (`@lmstudio/sdk`) для per-role tuning
 *
 * Декомпозиция выполнена 2026-04-30 (Phase 2.1 cross-platform roadmap).
 * Оригинальный god-файл был ~675 LOC.
 */

export {
  DEFAULT_LMS_URL,
  type LmsTransport,
  type OlympicsLogLevel,
  type OlympicsLogger,
  type OlympicsLogEventEmitter,
  type LmsModelInfo,
  type ChatResp,
  type OlympicsLLMHandle,
  type OlympicsLLMNamespace,
  type OlympicsLMStudioClient,
  makeLogger,
} from "./lms-client-types.js";

export {
  lmsListModelsV1,
  lmsListAvailableModels,
  lmsWaitForReady,
  lmsLoadModel,
  lmsUnloadModel,
  lmsHealthCheck,
  estimateModelVramBytes,
  lmsLoadedInstanceIdsForModel,
  lmsUnloadAllInstancesForModel,
  lmsChat,
} from "./lms-client-rest.js";

export {
  lmsLoadModelSDK,
  lmsUnloadModelSDK,
  _setOlympicsSdkClientForTests,
} from "./lms-client-sdk.js";
