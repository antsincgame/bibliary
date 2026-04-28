// @ts-check
/**
 * Minimal markdown renderer shared across all renderer modules.
 * Uses marked ESM build for HTML rendering.
 */
import { marked } from "../node_modules/marked/lib/marked.esm.js";

/**
 * Render markdown string to safe HTML.
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  if (!md) return "";
  return /** @type {string} */ (marked.parse(md, { async: false }));
}
