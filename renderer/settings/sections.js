// @ts-check

/**
 * @typedef {{
 *   key: string;
 *   type: "int"|"float"|"bool"|"enum"|"tags"|"url"|"password"|"text"|"textarea";
 *   min?: number;
 *   max?: number;
 *   step?: number;
 *   rows?: number;
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
 *   advanced?: boolean;
 *   readonly?: boolean;
 *   fields: SettingsField[];
 * }} SettingsSection
 */

/**
 * Iter 12 P5.4 settings rework: 4 базовых раздела (видны всегда) +
 * advanced toggle открывает legacy-разделы (resilience/pipeline/ui).
 *
 * Маппинг user request:
 *   "Библиотека и поиск" (ingest), "Устойчивость и политики" (resilience),
 *   "Пайплайн импорта" (pipeline) → УБРАТЬ из UI как разделы (advanced-only).
 *   "Calibre" → перенести в "Основные" (general).
 *   Семантический чанкер → добавить промптовое поле для описания.
 *   Авто-режим (memory management): adaptiveSchedulingEnabled.
 */

/** @type {ReadonlyArray<SettingsSection>} */
export const SECTIONS = Object.freeze([
  /* ─── Основные ──────────────────────────────────────────────────── */
  {
    id: "general",
    titleKey: "settings.section.general",
    descriptionKey: "settings.section.general.desc",
    icon: "MAIN",
    fields: [
      { key: "lmStudioUrl", type: "url", labelKey: "settings.lmStudioUrl", placeholder: "http://localhost:1234", probe: "lmstudio" },
      { key: "qdrantUrl", type: "url", labelKey: "settings.qdrantUrl", placeholder: "http://localhost:6333", probe: "qdrant" },
      { key: "calibrePathOverride", type: "text", labelKey: "settings.calibrePathOverride", placeholder: "C:\\Program Files\\Calibre2\\ebook-convert.exe" },
    ],
  },

  /* ─── OCR & Vision ──────────────────────────────────────────────── */
  {
    id: "ocr",
    titleKey: "settings.section.ocr",
    descriptionKey: "settings.section.ocr.desc",
    icon: "OCR",
    fields: [
      { key: "ocrEnabled", type: "bool", labelKey: "settings.ocrEnabled" },
      { key: "ocrAccuracy", type: "enum", options: ["fast", "accurate"], labelKey: "settings.ocrAccuracy" },
      { key: "ocrLanguages", type: "tags", labelKey: "settings.ocrLanguages", placeholder: "en, ru, uk" },
      { key: "ocrPdfDpi", type: "int", min: 100, max: 600, labelKey: "settings.ocrPdfDpi" },
      { key: "djvuOcrProvider", type: "enum", options: ["auto", "vision-llm", "system", "none"], labelKey: "settings.djvuOcrProvider" },
      { key: "djvuRenderDpi", type: "int", min: 100, max: 600, labelKey: "settings.djvuRenderDpi" },
      { key: "preferDjvuOverPdf", type: "bool", labelKey: "settings.preferDjvuOverPdf" },
      { key: "metadataOnlineLookup", type: "bool", labelKey: "settings.metadataOnlineLookup" },
      { key: "visionMetaEnabled", type: "bool", labelKey: "settings.visionMetaEnabled" },
    ],
  },

  /* ─── Семантический чанкер ──────────────────────────────────────── */
  {
    id: "chunker",
    titleKey: "settings.section.chunker",
    descriptionKey: "settings.section.chunker.desc",
    icon: "CHNK",
    fields: [
      { key: "chunkSafeLimit", type: "int", min: 500, max: 20000, labelKey: "settings.chunkSafeLimit" },
      { key: "chunkMinWords", type: "int", min: 50, max: 2000, labelKey: "settings.chunkMinWords" },
      { key: "driftThreshold", type: "float", min: 0, max: 1, step: 0.05, labelKey: "settings.driftThreshold" },
      { key: "maxParagraphsForDrift", type: "int", min: 100, max: 5000, labelKey: "settings.maxParagraphsForDrift" },
      { key: "overlapParagraphs", type: "int", min: 0, max: 10, labelKey: "settings.overlapParagraphs" },
      { key: "chunkerCustomPrompt", type: "textarea", rows: 5, labelKey: "settings.chunkerCustomPrompt", placeholder: "Опиши, как именно резать книгу…" },
    ],
  },

  /* ─── Авто-режим (memory & adaptive) ────────────────────────────── */
  {
    id: "auto",
    titleKey: "settings.section.auto",
    descriptionKey: "settings.section.auto.desc",
    icon: "AUTO",
    fields: [
      { key: "adaptiveSchedulingEnabled", type: "bool", labelKey: "settings.adaptiveSchedulingEnabled" },
    ],
  },

  /* ─── Advanced (скрыто по умолчанию) ────────────────────────────── */
  {
    id: "ingest",
    titleKey: "settings.section.ingest",
    descriptionKey: "settings.section.ingest.desc",
    icon: "BOOK",
    advanced: true,
    fields: [
      { key: "ingestParallelism", type: "int", min: 1, max: 16, labelKey: "settings.ingestParallelism" },
      { key: "searchPerSourceLimit", type: "int", min: 1, max: 50, labelKey: "settings.searchPerSourceLimit" },
      { key: "qdrantSearchLimit", type: "int", min: 1, max: 100, labelKey: "settings.qdrantSearchLimit" },
    ],
  },
  {
    id: "resilience",
    titleKey: "settings.section.resilience",
    descriptionKey: "settings.section.resilience.desc",
    icon: "SAFE",
    advanced: true,
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
    id: "pipeline",
    titleKey: "settings.section.pipeline",
    descriptionKey: "settings.section.pipeline.desc",
    icon: "PIPE",
    advanced: true,
    fields: [
      { key: "schedulerLightConcurrency", type: "int", min: 1, max: 32, labelKey: "settings.schedulerLightConcurrency" },
      { key: "schedulerMediumConcurrency", type: "int", min: 1, max: 8, labelKey: "settings.schedulerMediumConcurrency" },
      { key: "schedulerHeavyConcurrency", type: "int", min: 1, max: 4, labelKey: "settings.schedulerHeavyConcurrency" },
      { key: "parserPoolSize", type: "int", min: 0, max: 16, labelKey: "settings.parserPoolSize" },
      { key: "evaluatorSlots", type: "int", min: 1, max: 8, labelKey: "settings.evaluatorSlots" },
      { key: "visionOcrRpm", type: "int", min: 1, max: 600, labelKey: "settings.visionOcrRpm" },
      { key: "illustrationParallelism", type: "int", min: 1, max: 16, labelKey: "settings.illustrationParallelism" },
      { key: "illustrationParallelBooks", type: "int", min: 1, max: 16, labelKey: "settings.illustrationParallelBooks" },
      { key: "converterCacheMaxBytes", type: "int", min: 0, max: 50_000_000_000, labelKey: "settings.converterCacheMaxBytes" },
    ],
  },
  {
    id: "ui",
    titleKey: "settings.section.ui",
    descriptionKey: "settings.section.ui.desc",
    icon: "UI",
    advanced: true,
    fields: [
      { key: "resilienceBarHideDelayMs", type: "int", min: 1000, max: 30000, labelKey: "settings.resilienceBarHideDelayMs" },
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
    advanced: section.advanced === true,
    readonly: section.readonly === true,
  };
}
