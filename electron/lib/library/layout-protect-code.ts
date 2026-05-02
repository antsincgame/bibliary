/**
 * Layout pipeline: code-block protection.
 *
 * Тактическое требование Императора (Iter B–E): применять typograf,
 * drop-caps, sidenotes и KaTeX **только к прозовым токенам**, не к коду.
 *
 * Вместо тяжёлого AST через marked.lexer используем placeholder-pattern:
 *   1) до трансформаций: вырезаем все ```fenced``` и `inline code`,
 *      запоминаем порядок;
 *   2) применяем layout-stages к "чистому" тексту;
 *   3) возвращаем коды на место по обратному порядку.
 *
 * Эквивалентно AST-protection по эффекту (typograf не трогает «1+1=2»
 * внутри `var a = 1 + 1`), но в десятки раз дешевле.
 */

const PLACEHOLDER_PREFIX = "\u0000BIBL_CODE_";
const PLACEHOLDER_SUFFIX = "\u0000";

export interface CodeProtection {
  md: string;
  restore: (input: string) => string;
}

const FENCED_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

/**
 * Защищает все ``` fenced ``` и `inline code` блоки от модификации.
 * Возвращает протектированный markdown и функцию обратной подстановки.
 *
 * Идемпотентна: повторный protectCode на уже защищённом тексте просто
 * добавит ещё один уровень placeholders (но restore их разрулит).
 */
export function protectCode(md: string): CodeProtection {
  if (!md) {
    return { md, restore: (s) => s };
  }

  const buckets: string[] = [];
  let counter = 0;

  const replace = (full: string): string => {
    const id = counter++;
    buckets.push(full);
    return `${PLACEHOLDER_PREFIX}${id}${PLACEHOLDER_SUFFIX}`;
  };

  /* Fenced code blocks first (могут содержать обратные кавычки внутри). */
  let out = md.replace(FENCED_RE, replace);
  /* Inline code last. */
  out = out.replace(INLINE_CODE_RE, replace);

  return {
    md: out,
    restore: (input) => {
      if (!input || buckets.length === 0) return input;
      let restored = input;
      /* Restore in reverse: внутренние плейсхолдеры могут быть «обёрнуты»
         внешними при многоступенчатом protect (теоретический edge case). */
      for (let i = buckets.length - 1; i >= 0; i--) {
        const token = `${PLACEHOLDER_PREFIX}${i}${PLACEHOLDER_SUFFIX}`;
        restored = restored.split(token).join(buckets[i]);
      }
      return restored;
    },
  };
}

/**
 * Проверка, содержит ли строка placeholder (диагностика, тесты).
 */
export function hasCodePlaceholder(md: string): boolean {
  return md.includes(PLACEHOLDER_PREFIX);
}
