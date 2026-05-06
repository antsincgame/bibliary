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
