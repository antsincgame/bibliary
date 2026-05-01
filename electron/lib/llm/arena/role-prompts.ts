/**
 * Single source of truth for compact, reused role prompts in the arena.
 *
 * These constants are shared between:
 *   - Olympics disciplines (`disciplines.ts`)
 *   - Scoring module (`scoring.ts`)
 *
 * Each prompt is intentionally MINIMAL — single-token answers where possible,
 * no fuzzy adjectives ("helpful", "fair"), explicit format constraints.
 *
 * `JUDGE_SYSTEM_PROMPT` удалён 2026-05-01 (Иt 8А library-fortress) — роль
 * `judge` нигде не использовалась в продакшене и в дисциплинах Олимпиады.
 */

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
