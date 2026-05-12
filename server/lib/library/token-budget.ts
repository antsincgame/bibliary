/**
 * Phase 8e — Approximate token counting + budget enforcement.
 *
 * Без tiktoken/transformers dependency — approximation работает на
 * heuristic'ах per language. Достаточно для предварительного трим'а
 * перед LLM call; провайдер всё равно делает tokenize внутри.
 *
 * Эвристика:
 *   - Latin/ASCII text: ~4 chars per token (OpenAI / Anthropic average)
 *   - Cyrillic (Russian/Ukrainian): ~2 chars per token (Anthropic
 *     multilingual tokenizers режут UTF-8 на меньшие пьесы)
 *   - CJK / Asian languages: ~1.5 chars per token
 *
 * Это +-20% accuracy — для budget enforcement enough.
 */

const ASCII_CHARS_PER_TOKEN = 4;
const CYRILLIC_CHARS_PER_TOKEN = 2;
const CJK_CHARS_PER_TOKEN = 1.5;

function classifyChar(code: number): "ascii" | "cyrillic" | "cjk" | "other" {
  if (code < 0x80) return "ascii";
  if (code >= 0x0400 && code <= 0x04ff) return "cyrillic";        // Cyrillic
  if (code >= 0x0500 && code <= 0x052f) return "cyrillic";        // Cyrillic Supplement
  if (code >= 0x3000 && code <= 0x9fff) return "cjk";             // CJK
  if (code >= 0xac00 && code <= 0xd7af) return "cjk";             // Hangul
  if (code >= 0xf900 && code <= 0xfaff) return "cjk";             // CJK Compatibility
  return "other";
}

/**
 * Approximate token count for a string. Faster than tiktoken (~10MB
 * worth of WASM) и не требует precise count — purpose is budget guard.
 */
export function approxTokenCount(text: string): number {
  if (text.length === 0) return 0;
  let asciiChars = 0;
  let cyrillicChars = 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const cls = classifyChar(code);
    if (cls === "ascii") asciiChars += 1;
    else if (cls === "cyrillic") cyrillicChars += 1;
    else if (cls === "cjk") cjkChars += 1;
    else otherChars += 1;
  }
  const tokens =
    asciiChars / ASCII_CHARS_PER_TOKEN +
    cyrillicChars / CYRILLIC_CHARS_PER_TOKEN +
    cjkChars / CJK_CHARS_PER_TOKEN +
    otherChars / 3;
  return Math.ceil(tokens);
}

/**
 * Trim text к maxTokens budget. Cuts at sentence boundary (.!?…)
 * если возможно; иначе hard cut с appended "...".
 *
 * Используется в bridge'ах ПЕРЕД sending chunk в crystallizer
 * (≤2000 tok budget per chunk per .claude/rules/02-extraction.md
 * recommended size).
 */
export function trimToTokenBudget(text: string, maxTokens: number): {
  text: string;
  originalTokens: number;
  trimmed: boolean;
} {
  const originalTokens = approxTokenCount(text);
  if (originalTokens <= maxTokens) {
    return { text, originalTokens, trimmed: false };
  }

  /* Хищный shortcut: take proportional chars to expected token count. */
  const ratio = maxTokens / originalTokens;
  const charBudget = Math.floor(text.length * ratio * 0.95); // 5% safety margin

  const truncated = text.slice(0, charBudget);
  /* Find last sentence boundary in truncated. */
  const sentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
    truncated.lastIndexOf("…"),
    truncated.lastIndexOf(".\n"),
    truncated.lastIndexOf("?\n"),
    truncated.lastIndexOf("!\n"),
  );
  const cut =
    sentenceEnd > charBudget * 0.7
      ? truncated.slice(0, sentenceEnd + 1)
      : truncated.trimEnd() + " …";
  return { text: cut, originalTokens, trimmed: true };
}
