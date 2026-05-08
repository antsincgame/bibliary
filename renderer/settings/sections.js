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
 *   probe?: "lmstudio"|"chroma";
 *   labelKey: string;
 * }} SettingsField
 *
 * @typedef {{
 *   id: string;
 *   titleKey: string;
 *   descriptionKey: string;
 *   icon: string;
 *   readonly?: boolean;
 *   fields: SettingsField[];
 * }} SettingsSection
 */

/**
 * Iter 14.1 (2026-05-04): «бабушка-библиотекарь» — продвинутые разделы
 * (распознавание / чанкер / авто-режим / устойчивость / пайплайн / UI)
 * полностью удалены из UI настроек. Их значения берутся из дефолтов
 * Zod schema (electron/lib/preferences/store.ts) и работают «из коробки».
 * Для пользователя остаётся только главное — два URL.
 */

/** @type {ReadonlyArray<SettingsSection>} */
export const SECTIONS = Object.freeze([
  {
    id: "general",
    titleKey: "settings.section.general",
    descriptionKey: "settings.section.general.desc",
    icon: "MAIN",
    fields: [
      { key: "lmStudioUrl", type: "url", labelKey: "settings.lmStudioUrl", placeholder: "http://localhost:1234", probe: "lmstudio" },
      { key: "chromaUrl", type: "url", labelKey: "settings.chromaUrl", placeholder: "http://localhost:8000", probe: "chroma" },
    ],
  },
  /* Uniqueness Evaluator — единственная advanced-секция, восстановленная после
   * Iter 14.1 simplification. Дефолты Zod schema работают «из коробки», но
   * пользователи с нестандартным железом / корпусом могут хотеть тюнить пороги
   * и параллелизм. Все поля имеют sensible defaults — изменять не обязательно. */
  {
    id: "uniqueness",
    titleKey: "settings.section.uniqueness",
    descriptionKey: "settings.section.uniqueness.desc",
    icon: "U",
    fields: [
      { key: "uniquenessEvaluationEnabled", type: "bool", labelKey: "settings.uniquenessEvaluationEnabled" },
      { key: "uniquenessChapterParallel", type: "int", min: 1, max: 8, step: 1, labelKey: "settings.uniquenessChapterParallel" },
      { key: "uniquenessIdeasPerChapterMax", type: "int", min: 2, max: 15, step: 1, labelKey: "settings.uniquenessIdeasPerChapterMax" },
      { key: "uniquenessSimilarityHigh", type: "float", min: 0.5, max: 1, step: 0.01, labelKey: "settings.uniquenessSimilarityHigh" },
      { key: "uniquenessSimilarityLow", type: "float", min: 0, max: 0.95, step: 0.01, labelKey: "settings.uniquenessSimilarityLow" },
      { key: "uniquenessMergeThreshold", type: "float", min: 0.7, max: 1, step: 0.01, labelKey: "settings.uniquenessMergeThreshold" },
      { key: "conceptDedupEnabled", type: "bool", labelKey: "settings.conceptDedupEnabled" },
      { key: "conceptDedupSimilarityThreshold", type: "float", min: 0.8, max: 1, step: 0.01, labelKey: "settings.conceptDedupSimilarityThreshold" },
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
    readonly: section.readonly === true,
  };
}
