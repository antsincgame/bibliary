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

/** UI-пресеты порога качества для toolbar Catalog. Любой 0 == "all". */
export const QUALITY_PRESETS = Object.freeze([
  { key: "all",      value: 0  },
  { key: "workable", value: 50 },
  { key: "solid",    value: 70 },
  { key: "premium",  value: 86 },
]);

/**
 * @typedef {object} CatalogFilters
 * @property {number} quality        Minimum qualityScore (0 = no filter).
 * @property {boolean} hideFiction   Hide rows where isFictionOrWater === true.
 * @property {string} search         Free-text needle (case-insensitive).
 */

/**
 * Pure: returns rows passing UI filters.
 *
 * Контракт:
 *   - quality 0 → пропускает всё; иначе строки без qualityScore (≠ number) отсекаются.
 *   - hideFiction → если строка isFictionOrWater === true, она вылетает; иначе остаётся.
 *   - search → join по titleEn/title/authorEn/author/domain/tags; case-insensitive includes.
 *
 * @param {Array<object>} rows
 * @param {CatalogFilters} filters
 * @returns {Array<object>}
 */
export function filterCatalog(rows, filters) {
  const q = filters.quality;
  const hide = filters.hideFiction;
  const needle = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (q > 0) {
      const score = typeof row.qualityScore === "number" ? row.qualityScore : -1;
      if (score < q) return false;
    }
    if (hide && row.isFictionOrWater === true) return false;
    if (needle) {
      const haystack = [
        row.titleEn, row.title, row.authorEn, row.author, row.domain,
        ...(row.tags ?? []),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
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
