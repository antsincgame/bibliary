/**
 * Layout pipeline: drop caps for chapter openings.
 *
 * Тактическое замечание Императора (брифинг перед боем):
 *   «Часто после заголовка идёт эпиграф (Blockquote), картинка,
 *    или просто пустая строка. Если повесить <span class="dropcap">
 *    на символ ! из картинки — вёрстка взорвётся. В layout-dropcaps.ts
 *    прогоняйте поиск только по первому ТЕКСТОВОМУ параграфу
 *    (начинающемуся с [А-Яа-яA-Za-z]).»
 *
 * Реализация:
 *   1. Делим текст на блоки (split по \n\n+).
 *   2. Идём по блокам. После заголовка `# ` или `## ` ставим флаг
 *      «ищем первый текстовый параграф».
 *   3. Пропускаем blockquote (>), images (!), lists (*-+), tables (|),
 *      escapes (\), HTML (<), code-плейсхолдеры (\u0000).
 *   4. Первая ascii/кириллическая буква → <span class="lib-reader-dropcap">X</span>.
 *
 * Идемпотентность: если блок уже содержит `lib-reader-dropcap`, пропускаем.
 */

const HEADING_RE = /^#{1,2}\s+\S/;
const FIRST_LETTER_RE = /^([А-Яа-яA-Za-zЁё])([\s\S]+)$/;

export function applyDropcaps(md: string): string {
  if (!md) return md;

  const blocks = md.split(/\n{2,}/);
  let lookingForFirstPara = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const trimmed = block.trimStart();

    /* Заголовок — взводим флаг и идём дальше. */
    if (HEADING_RE.test(trimmed)) {
      lookingForFirstPara = true;
      continue;
    }
    if (!lookingForFirstPara) continue;

    /* Идемпотентность: если в этой главе уже есть drop-cap (повторный
       прогон applyLayout), снимаем флаг и идём дальше. Иначе можем
       повесить второй dropcap на следующий текстовый параграф. */
    if (trimmed.includes("lib-reader-dropcap")) {
      lookingForFirstPara = false;
      continue;
    }

    /* Блоки, к которым drop-cap НЕ применим (тактическое требование):
       это эпиграфы / картинки / списки / таблицы / уже-HTML / code.
       lookingForFirstPara сохраняем — ищем дальше первый текстовый. */
    if (
      trimmed.length === 0 ||
      trimmed.startsWith(">") || // blockquote / эпиграф
      trimmed.startsWith("!") || // image
      trimmed.startsWith("*") || // list / italic
      trimmed.startsWith("-") || // list / hr
      trimmed.startsWith("+") || // list
      trimmed.startsWith("|") || // table
      trimmed.startsWith("\\") || // escape
      trimmed.startsWith("<") || // raw HTML (включая callouts/sidenotes)
      trimmed.startsWith("\u0000") || // code placeholder
      trimmed.startsWith("```") || // fenced (на случай если protect не сработал)
      trimmed.startsWith("    ") // indented code
    ) {
      continue;
    }

    const m = FIRST_LETTER_RE.exec(trimmed);
    if (!m) continue;

    const indent = block.length - trimmed.length;
    blocks[i] =
      block.slice(0, indent) +
      `<span class="lib-reader-dropcap">${m[1]}</span>${m[2]}`;
    lookingForFirstPara = false; // только один drop-cap на главу
  }

  return blocks.join("\n\n");
}
