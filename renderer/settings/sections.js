// @ts-check

/**
 * @typedef {"simple"|"advanced"|"pro"} SectionMode
 *
 * @typedef {{
 *   key: string;
 *   type: "int"|"float"|"bool"|"enum"|"tags"|"url"|"password"|"text";
 *   min?: number;
 *   max?: number;
 *   step?: number;
 *   options?: string[];
 *   placeholder?: string;
 *   probe?: "lmstudio"|"qdrant";
 *   labelKey: string;
 * }} SettingsField
 *
 * @typedef {{
 *   id: string;
 *   titleKey: string;
 *   descriptionKey: string;
 *   icon: string;
 *   mode: SectionMode;
 *   fields: SettingsField[];
 * }} SettingsSection
 */

/** @type {ReadonlyArray<SettingsSection>} */
export const SECTIONS = Object.freeze([
  {
    id: "ingest",
    titleKey: "settings.section.ingest",
    descriptionKey: "settings.section.ingest.desc",
    icon: "BOOK",
    mode: "simple",
    fields: [
      { key: "ingestParallelism", type: "int", min: 1, max: 16, labelKey: "settings.ingestParallelism" },
      { key: "searchPerSourceLimit", type: "int", min: 1, max: 50, labelKey: "settings.searchPerSourceLimit" },
      { key: "qdrantSearchLimit", type: "int", min: 1, max: 100, labelKey: "settings.qdrantSearchLimit" },
    ],
  },
  {
    id: "chunker",
    titleKey: "settings.section.chunker",
    descriptionKey: "settings.section.chunker.desc",
    icon: "CHNK",
    mode: "advanced",
    fields: [
      { key: "chunkSafeLimit", type: "int", min: 500, max: 20000, labelKey: "settings.chunkSafeLimit" },
      { key: "chunkMinWords", type: "int", min: 50, max: 2000, labelKey: "settings.chunkMinWords" },
      { key: "driftThreshold", type: "float", min: 0, max: 1, step: 0.05, labelKey: "settings.driftThreshold" },
      { key: "maxParagraphsForDrift", type: "int", min: 100, max: 5000, labelKey: "settings.maxParagraphsForDrift" },
      { key: "overlapParagraphs", type: "int", min: 0, max: 10, labelKey: "settings.overlapParagraphs" },
    ],
  },
  {
    id: "judge",
    titleKey: "settings.section.judge",
    descriptionKey: "settings.section.judge.desc",
    icon: "JDG",
    mode: "advanced",
    fields: [
      { key: "judgeScoreThreshold", type: "float", min: 0, max: 1, step: 0.05, labelKey: "settings.judgeScoreThreshold" },
      { key: "crossLibDupeThreshold", type: "float", min: 0, max: 1, step: 0.01, labelKey: "settings.crossLibDupeThreshold" },
      { key: "intraDedupThreshold", type: "float", min: 0, max: 1, step: 0.01, labelKey: "settings.intraDedupThreshold" },
    ],
  },
  {
    id: "resilience",
    titleKey: "settings.section.resilience",
    descriptionKey: "settings.section.resilience.desc",
    icon: "SAFE",
    mode: "pro",
    fields: [
      { key: "policyMaxRetries", type: "int", min: 0, max: 20, labelKey: "settings.policyMaxRetries" },
      { key: "policyBaseBackoffMs", type: "int", min: 100, max: 30000, labelKey: "settings.policyBaseBackoffMs" },
      { key: "hardTimeoutCapMs", type: "int", min: 30000, max: 3600000, labelKey: "settings.hardTimeoutCapMs" },
      { key: "lockRetries", type: "int", min: 0, max: 20, labelKey: "settings.lockRetries" },
      { key: "lockStaleMs", type: "int", min: 1000, max: 60000, labelKey: "settings.lockStaleMs" },
      { key: "healthPollIntervalMs", type: "int", min: 1000, max: 60000, labelKey: "settings.healthPollIntervalMs" },
      { key: "healthFailThreshold", type: "int", min: 1, max: 20, labelKey: "settings.healthFailThreshold" },
      { key: "watchdogLivenessTimeoutMs", type: "int", min: 500, max: 15000, labelKey: "settings.watchdogLivenessTimeoutMs" },
    ],
  },
  {
    id: "ui",
    titleKey: "settings.section.ui",
    descriptionKey: "settings.section.ui.desc",
    icon: "UI",
    mode: "simple",
    fields: [
      { key: "refreshIntervalMs", type: "int", min: 2000, max: 60000, labelKey: "settings.refreshIntervalMs" },
      { key: "toastTtlMs", type: "int", min: 1000, max: 30000, labelKey: "settings.toastTtlMs" },
      { key: "spinDurationMs", type: "int", min: 100, max: 3000, labelKey: "settings.spinDurationMs" },
      { key: "resilienceBarHideDelayMs", type: "int", min: 1000, max: 30000, labelKey: "settings.resilienceBarHideDelayMs" },
    ],
  },
  {
    id: "ocr",
    titleKey: "settings.section.ocr",
    descriptionKey: "settings.section.ocr.desc",
    icon: "OCR",
    mode: "simple",
    fields: [
      { key: "ocrEnabled", type: "bool", labelKey: "settings.ocrEnabled" },
      { key: "ocrAccuracy", type: "enum", options: ["fast", "accurate"], labelKey: "settings.ocrAccuracy" },
      { key: "ocrLanguages", type: "tags", labelKey: "settings.ocrLanguages", placeholder: "en, ru, fr" },
      { key: "ocrPdfDpi", type: "int", min: 100, max: 400, labelKey: "settings.ocrPdfDpi" },
      { key: "djvuOcrProvider", type: "enum", options: ["system", "vision-llm", "none"], labelKey: "settings.djvuOcrProvider" },
      { key: "djvuRenderDpi", type: "int", min: 100, max: 600, labelKey: "settings.djvuRenderDpi" },
      { key: "openrouterApiKey", type: "password", labelKey: "settings.openrouterApiKey", placeholder: "sk-or-v1-..." },
      { key: "metadataOnlineLookup", type: "bool", labelKey: "settings.metadataOnlineLookup" },
      { key: "visionMetaEnabled", type: "bool", labelKey: "settings.visionMetaEnabled" },
      { key: "visionModelKey", type: "text", labelKey: "settings.visionModelKey", placeholder: "qwen3-vl-7b-q4..." },
    ],
  },
  {
    id: "connectivity",
    titleKey: "settings.section.connectivity",
    descriptionKey: "settings.section.connectivity.desc",
    icon: "NET",
    mode: "simple",
    fields: [
      { key: "lmStudioUrl", type: "url", labelKey: "settings.lmStudioUrl", placeholder: "http://localhost:1234", probe: "lmstudio" },
      { key: "qdrantUrl", type: "url", labelKey: "settings.qdrantUrl", placeholder: "http://localhost:6333", probe: "qdrant" },
    ],
  },
]);

export function getSectionMeta(sectionId) {
  const section = SECTIONS.find((item) => item.id === sectionId);
  if (!section) return null;
  return {
    id: section.id,
    titleKey: section.titleKey,
    descriptionKey: section.descriptionKey,
    icon: section.icon,
    mode: section.mode,
  };
}
