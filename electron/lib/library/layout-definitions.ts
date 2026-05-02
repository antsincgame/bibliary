/**
 * Layout pipeline: definition detection.
 *
 * Распознаёт научные определения в начале строки:
 *   "Энтропия — это мера неопределённости..."
 *   "Энтропия = мера неопределённости..."
 *   "Entropy — a measure of uncertainty..."
 *
 * Только сам термин обёртывается в <dfn class="lib-reader-dfn">,
 * остальная строка остаётся обычным текстом. Это позволяет CSS (Iter C)
 * подсветить термин (полужирный + accent цвет) без нарушения typograf.
 *
 * Идемпотентность: если строка уже содержит `<dfn`, пропускаем.
 */

/* Срабатывает только на ПЕРВОМ символе строки (^), термин — кириллица/
   латиница 1–80 символов (короткое имя), за ним длинное тире и
   связка "это"/двоеточие/равно. Не работает в середине предложения,
   чтобы не ловить «Я хочу сказать что энтропия — это...». */
const DEFINITION_RE =
  /^([А-Яа-яA-Za-zЁё][А-Яа-яA-Za-zЁё0-9 \-]{0,79}?)(\s+[—–-]\s+(?:это[\s:]|это:?\s|:\s+|это\s)|\s*=\s+)(.+)$/;

/**
 * Обогащает определения семантическим тегом <dfn>.
 *
 * Работает построчно (не по блокам), потому что определение — это
 * одно предложение, а не целый параграф.
 */
export function applyDefinitions(md: string): string {
  if (!md) return md;

  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedStart = line.trimStart();
    /* HTML / blockquote / list — не трогаем. */
    if (
      trimmedStart.startsWith("<") ||
      trimmedStart.startsWith(">") ||
      trimmedStart.startsWith("#") ||
      trimmedStart.startsWith("*") ||
      trimmedStart.startsWith("-") ||
      trimmedStart.startsWith("+") ||
      trimmedStart.startsWith("|") ||
      trimmedStart.startsWith("!") ||
      trimmedStart.startsWith("\u0000") /* code placeholder */
    ) {
      continue;
    }
    if (line.includes("<dfn")) continue; /* idempotent */

    const m = DEFINITION_RE.exec(line);
    if (!m) continue;

    const term = m[1].trim();
    /* Защита от слишком общих ловушек: если "термин" — это короткие слова
       вроде "Я", "Он", "Это" — это не определение, а проза. */
    if (term.length < 2) continue;
    const lowercase = term.toLowerCase();
    if (
      lowercase === "я" ||
      lowercase === "он" ||
      lowercase === "она" ||
      lowercase === "оно" ||
      lowercase === "это" ||
      lowercase === "i" ||
      lowercase === "we" ||
      lowercase === "he" ||
      lowercase === "she" ||
      lowercase === "it" ||
      lowercase === "this" ||
      lowercase === "that"
    ) {
      continue;
    }

    const connector = m[2];
    const rest = m[3];
    const indent = line.length - trimmedStart.length;
    lines[i] =
      line.slice(0, indent) +
      `<dfn class="lib-reader-dfn">${term}</dfn>${connector}${rest}`;
  }
  return lines.join("\n");
}
