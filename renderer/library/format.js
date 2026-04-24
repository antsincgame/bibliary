// @ts-check
/**
 * Pure formatting helpers extracted from renderer/library.js.
 *
 * Strangler step #1: эти функции не трогают DOM/state, поэтому
 * могут жить в отдельном модуле и тестироваться юнит-тестами без
 * jsdom. Любая правка не должна добавлять побочных эффектов.
 */

/** "1.23 MB" / "--" для bytes <= 0. */
export function fmtMB(bytes) {
  if (!bytes) return "--";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

/** Человекочитаемая дата ISO-строки; на ошибку парсинга возвращает вход без изменений. */
export function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/** "1.2k" / "1.5M" / "—" для не-числа. */
export function fmtWords(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/** Целое 0..100 либо "—". */
export function fmtQuality(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return String(Math.round(n));
}

/**
 * Адаптивные единицы измерения для search-card download progress.
 * 0 → "0 B", <1KB → "N B", <1MB → "N.N KB", иначе → "N.N MB".
 */
export function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * CSS-эскейп для атрибутных селекторов. Использует CSS.escape если он
 * доступен (browser/Electron renderer); иначе fallback на ASCII-safe.
 */
export function cssEscape(str) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(str);
  return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** Уникальный id скачивания: crypto.randomUUID если доступен, иначе ts+rand. */
export function makeDownloadId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "dl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
