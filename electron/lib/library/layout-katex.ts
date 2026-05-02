/**
 * Layout pipeline: KaTeX server-side math rendering (LOCAL ONLY).
 *
 * Тактическое замечание Императора (брифинг перед боем):
 *   «katex.renderToString бросает жёсткие исключения (throw ParseError),
 *    если внутри $...$ синтаксически неверный LaTeX (а в старых книгах
 *    OCR часто парсит формулы с ошибками). Обязательно оборачивайте
 *    вызов KaTeX в try/catch. Если формула битая, возвращайте оригинальный
 *    сырой текст $...$, чтобы импорт не прервался из-за одной опечатки.»
 *
 * Также: «Афинян внешних серверов нам не надо». KaTeX npm-пакет — полностью
 * офлайн, никаких CDN/API. Шрифты и CSS будут вендоренны в Iter E
 * (renderer/vendor/katex/) и подключены через @font-face, не https://.
 *
 * Поведение:
 *   $$ display $$  → <span class="katex-display">…</span>  (block)
 *   $ inline $     → <span class="katex">…</span>          (inline)
 *   ParseError     → возвращаем сырой "$x^2$" (graceful)
 */
import katex from "katex";

/* Display math first (greedy match для многострочных формул).
   Используем nongreedy `[\s\S]+?` — match до ближайшего `$$`. */
const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g;

/* Inline math — однострочный, без `\n` внутри, минимум один символ
   между знаками. Отрицательный lookahead `(?!\$)` чтобы не путать с $$. */
const INLINE_MATH_RE = /(?<![$\\])\$([^\$\n]+?)\$(?!\$)/g;

interface KatexOptions {
  displayMode: boolean;
  throwOnError: boolean;
  strict: "ignore";
}

const DISPLAY_OPTS: KatexOptions = {
  displayMode: true,
  throwOnError: true /* МЫ хотим catch-able error для graceful fallback */,
  strict: "ignore" /* warnings → silent (на старых OCR много \ошибок) */,
};

const INLINE_OPTS: KatexOptions = {
  displayMode: false,
  throwOnError: true,
  strict: "ignore",
};

function safeRender(expr: string, opts: KatexOptions, raw: string): string {
  try {
    return katex.renderToString(expr.trim(), opts);
  } catch {
    /* ParseError, undefined macro, etc. — возвращаем сырой markdown
       чтобы импорт не падал на одной битой формуле. */
    return raw;
  }
}

/**
 * Применяет KaTeX к `$...$` и `$$...$$` блокам.
 *
 * Безопасно для:
 *  - code blocks (защищены protectCode перед вызовом);
 *  - markdown ссылок типа `[$5](url)` — там нет парного `$`;
 *  - битых формул (try/catch → raw fallback).
 */
export function applyKatex(md: string): string {
  if (!md) return md;

  /* Display first — иначе INLINE_MATH_RE съест внутренности $$...$$. */
  let out = md.replace(DISPLAY_MATH_RE, (full, expr) =>
    safeRender(String(expr), DISPLAY_OPTS, full),
  );
  out = out.replace(INLINE_MATH_RE, (full, expr) =>
    safeRender(String(expr), INLINE_OPTS, full),
  );

  return out;
}
