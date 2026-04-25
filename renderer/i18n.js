// @ts-check
import ruDict from "./locales/ru.js";
import enDict from "./locales/en.js";

const STORAGE_KEY = "bibliary_locale";
const DEFAULT_LOCALE = "ru";
const SUPPORTED = /** @type {const} */ (["ru", "en"]);

/** @typedef {"ru"|"en"} Locale */

const DICT = /** @type {Record<Locale, Record<string,string>>} */ ({
  ru: ruDict,
  en: enDict,
});

/** @type {Locale} */
let currentLocale = readLocale();

/** @returns {Locale} */
function readLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.includes(/** @type {Locale} */ (stored))) {
      return /** @type {Locale} */ (stored);
    }
  } catch {
    // localStorage unavailable (SSR / restricted context)
  }
  return DEFAULT_LOCALE;
}

/** @returns {Locale} */
export function getLocale() {
  return currentLocale;
}

/** @returns {ReadonlyArray<Locale>} */
export function listLocales() {
  return SUPPORTED;
}

/** @param {Locale} loc */
export function setLocale(loc) {
  if (!SUPPORTED.includes(loc) || loc === currentLocale) return;
  currentLocale = loc;
  try {
    localStorage.setItem(STORAGE_KEY, loc);
  } catch {
    // localStorage unavailable
  }
  document.documentElement.lang = loc;
  applyI18n(document);
  for (const fn of subscribers) {
    try { fn(loc); } catch { /* subscriber error */ }
  }
}

/** @type {Set<(loc: Locale) => void>} */
const subscribers = new Set();

/** @param {(loc: Locale) => void} fn @returns {() => void} */
export function onLocaleChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  const dict = DICT[currentLocale] || DICT[DEFAULT_LOCALE];
  let template = dict[key];
  if (template === undefined) {
    template = DICT[DEFAULT_LOCALE][key];
  }
  if (template === undefined) return key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    vars[name] !== undefined ? String(vars[name]) : ""
  );
}

/**
 * Walks the DOM and applies translations declared via attributes:
 * - `data-i18n="key"` -> textContent
 * - `data-i18n-html="key"` -> innerHTML (use sparingly, only for trusted keys)
 * - `data-i18n-attr="title:key,placeholder:key2"` -> arbitrary attributes
 *
 * @param {Document|Element} root
 */
export function applyI18n(root) {
  const scope = /** @type {ParentNode} */ (root);
  scope.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (key) node.textContent = t(key);
  });
  scope.querySelectorAll("[data-i18n-html]").forEach((node) => {
    const key = node.getAttribute("data-i18n-html");
    if (key) node.innerHTML = t(key);
  });
  scope.querySelectorAll("[data-i18n-attr]").forEach((node) => {
    const spec = node.getAttribute("data-i18n-attr");
    if (!spec) return;
    for (const pair of spec.split(",")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    }
  });
}

if (typeof document !== "undefined") {
  document.documentElement.lang = currentLocale;
}
