// @ts-check
/**
 * Minimal markdown renderer shared across all renderer modules.
 * Uses marked ESM build for HTML rendering.
 *
 * NOTE: renderer работает через Electron loadFile() БЕЗ bundler'а.
 * Bare specifier "marked" в браузере не резолвится — поэтому используем
 * прямой path до marked.esm.js. Архитектурный TODO: vendor-copy под
 * renderer/vendor/marked/ (как сделано для katex), чтобы убрать
 * хрупкую привязку к node_modules layout. См. roadmap test-gap audit.
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
