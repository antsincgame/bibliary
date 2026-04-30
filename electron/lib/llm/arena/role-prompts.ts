/**
 * Single source of truth for compact, reused role prompts in the arena.
 *
 * These constants are shared between:
 *   - Olympics disciplines (`disciplines.ts`)
 *   - Scoring module (`scoring.ts`)
 *
 * Each prompt is intentionally MINIMAL — single-token answers where possible,
 * no fuzzy adjectives ("helpful", "fair"), explicit format constraints.
 */

/**
 * Judge — A/B picker. Used hundreds of times in Bradley-Terry matches.
 * Must answer in 1 token to keep arena sub-minute.
 *
 * Anti-bias notes:
 *   - "strict" instead of "fair" (less drift toward neutrality bias).
 *   - Explicit "no other text" — many small models prepend "The answer is".
 *   - Single token cap (`maxTokens: 16`) at call site.
 */
export const JUDGE_SYSTEM_PROMPT =
  "You are a precise A/B picker. Compare two short answers. " +
  "Pick which is factually correct. Output exactly one character: A or B. " +
  "No prefix, no explanation, no punctuation, no other text.";

/**
 * Lang detector — single-token language code.
 * Used in import pipeline (regex first, LLM as fallback).
 */
export const LANG_DETECT_SYSTEM_PROMPT =
  "You detect language. Output ONLY one of these codes: ru, uk, en, de. " +
  "No punctuation, no explanation, no other text.";

/**
 * Translator — Russian-direction. Default for the production translator role.
 */
export const TRANSLATE_TO_RU_SYSTEM_PROMPT =
  "You are a professional translator. Translate the user's text into Russian. " +
  "Preserve technical terms, proper names, code snippets, formulas and numbers exactly. " +
  "Output ONLY the translation. No commentary, no quotes, no explanations. " +
  "BAD: 'Here is the translation: ...' — never do this. " +
  "BAD: emitting Ukrainian letters (іїєґ) when target is Russian — never do this.";

/**
 * Translator — English-direction.
 */
export const TRANSLATE_TO_EN_SYSTEM_PROMPT =
  "You are a professional translator. Translate the user's text into English. " +
  "Preserve technical terms, proper names, code snippets, formulas and numbers exactly. " +
  "Output ONLY the translation. No commentary, no quotes, no explanations. " +
  "BAD: 'Here is the translation: ...' — never do this. " +
  "BAD: leaving Cyrillic words untranslated when an English equivalent exists.";
