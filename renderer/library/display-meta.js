// @ts-check
/**
 * Locale-aware bibliographic title/author/tags for catalog, collections, reader.
 */
import { getLocale } from "../i18n.js";

/**
 * @param {{ id: string; title: string; titleRu?: string; titleEn?: string }} row
 */
export function displayBookTitle(row) {
  const loc = getLocale();
  if (loc === "ru") {
    const v = (row.titleRu || row.title || row.titleEn || "").trim();
    return v || row.id;
  }
  const v = (row.titleEn || row.title || row.titleRu || "").trim();
  return v || row.id;
}

/**
 * @param {{ author?: string; authorRu?: string; authorEn?: string }} row
 */
export function displayBookAuthor(row) {
  const loc = getLocale();
  if (loc === "ru") {
    return (row.authorRu || row.author || row.authorEn || "").trim();
  }
  return (row.authorEn || row.author || row.authorRu || "").trim();
}

/**
 * `title` attribute for table row: show alternate + original when useful.
 * @param {{ title: string; titleRu?: string; titleEn?: string }} row
 */
export function bookTitleTooltip(row) {
  const shown = displayBookTitle(row);
  const orig = (row.title || "").trim();
  const altRu = (row.titleRu || "").trim();
  const altEn = (row.titleEn || "").trim();
  const parts = [shown];
  if (orig && orig !== shown) parts.push(`orig: ${orig}`);
  if (altRu && altRu !== shown) parts.push(`RU: ${altRu}`);
  if (altEn && altEn !== shown) parts.push(`EN: ${altEn}`);
  return parts.join(" · ");
}

/**
 * Tags for current UI language (RU list if non-empty when locale is ru, else EN; fallback to the other).
 * @param {{ tags?: string[]; tagsRu?: string[] }} row
 * @returns {string[]}
 */
export function displayBookTags(row) {
  const loc = getLocale();
  const en = Array.isArray(row.tags) ? row.tags : [];
  const ru = Array.isArray(row.tagsRu) ? row.tagsRu : [];
  if (loc === "ru") {
    return ru.length > 0 ? ru : en;
  }
  return en.length > 0 ? en : ru;
}
