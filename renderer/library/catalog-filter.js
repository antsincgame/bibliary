// @ts-check
/**
 * Pure catalog filter & class helpers extracted from renderer/library.js.
 *
 * Strangler step #1: filterCatalog + qualityClass + statusClass — это
 * чистые функции от данных строки. Их легко покрывать unit-тестами,
 * и они не должны зависеть от STATE/CATALOG/DOM.
 *
 * Любая UI-обвязка (renderCatalogTable, syncPresetActive) остаётся в
 * renderer/library.js до следующей итерации strangler'а.
 */
import { displayBookTags } from "./display-meta.js";

/**
 * UI-пресеты порога качества для toolbar Catalog.
 *
 * Контракт (используется в renderer/library/catalog.js):
 *   - key:        стабильный идентификатор для тестов и data-атрибутов
 *   - minQuality: порог Quality (0 = «без фильтра»)
 *   - hideFiction: автоматически скрыть фикшн при выборе пресета
 *   - labelKey:   i18n-ключ для подписи кнопки (см. renderer/i18n.js)
 */
export const QUALITY_PRESETS = Object.freeze([
  { key: "all",      minQuality: 0,  hideFiction: false, labelKey: "library.catalog.filter.preset.all" },
  { key: "workable", minQuality: 50, hideFiction: true,  labelKey: "library.catalog.filter.preset.workable" },
  { key: "solid",    minQuality: 70, hideFiction: true,  labelKey: "library.catalog.filter.preset.solid" },
  { key: "premium",  minQuality: 86, hideFiction: true,  labelKey: "library.catalog.filter.preset.premium" },
]);

/**
 * @typedef {object} CatalogFilters
 * @property {number} quality        Minimum qualityScore (0 = no filter).
 * @property {boolean} hideFiction   Hide rows where isFictionOrWater === true.
 * @property {string} search         Free-text needle (case-insensitive).
 * @property {string[]} [tags]       AND-filter: only rows whose tags include ALL of these.
 */

/**
 * Pure: returns rows passing UI filters.
 *
 * Контракт:
 *   - quality 0 → пропускает всё; иначе строки без qualityScore (≠ number) отсекаются.
 *   - hideFiction → если строка isFictionOrWater === true, она вылетает; иначе остаётся.
 *   - search → join по titleEn/titleRu/title/authorEn/authorRu/author/domain/tags/tagsRu; case-insensitive includes.
 *
 * @param {Array<object>} rows
 * @param {CatalogFilters} filters
 * @returns {Array<object>}
 */
export function filterCatalog(rows, filters) {
  const q = filters.quality;
  const hide = filters.hideFiction;
  const needle = filters.search.trim().toLowerCase();
  const tagFilter = filters.tags && filters.tags.length > 0 ? filters.tags : null;
  const bookIdFilter = filters.filterBookIds instanceof Set ? filters.filterBookIds : null;
  return rows.filter((row) => {
    if (bookIdFilter && !bookIdFilter.has(row.id)) return false;
    if (q > 0) {
      const score = typeof row.qualityScore === "number" ? row.qualityScore : -1;
      if (score < q) return false;
    }
    if (hide && row.isFictionOrWater === true) return false;
    if (needle) {
      const haystack = [
        row.titleEn, row.titleRu, row.title, row.authorEn, row.authorRu, row.author, row.domain,
        ...(row.tags ?? []),
        ...(row.tagsRu ?? []),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (tagFilter) {
      const rowTags = displayBookTags(row);
      if (!tagFilter.every((tg) => rowTags.includes(tg))) return false;
    }
    return true;
  });
}

/** Класс цветовой шкалы качества. unset = NaN/undefined. */
export function qualityClass(n) {
  if (typeof n !== "number") return "lib-q-unset";
  if (n >= 86) return "lib-q-premium";
  if (n >= 70) return "lib-q-solid";
  if (n >= 50) return "lib-q-workable";
  return "lib-q-low";
}

/** Sanitize-обёртка для CSS-имени статуса: только [A-Za-z0-9_-]. */
export function statusClass(status) {
  return "lib-status-" + status.replace(/[^a-z0-9_-]/gi, "");
}
