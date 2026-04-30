/**
 * Unified Unicode-aware text tokenization for Bibliary.
 *
 * Раньше в проекте было несколько разных реализаций одного приёма
 * (`import-candidate-filter`, e2e-скрипты). Все они делали одно и то же:
 *   1. lowercase
 *   2. split по `[^\p{L}\p{N}]+` (любые буквы и цифры из любого языка)
 *   3. фильтр по длине
 *
 * Решение: один низкоуровневый `unicodeTokenize(text, opts)` + тонкие
 * враппер-helper'ы с дефолтами под use-case.
 *
 * Свойства:
 *   - Multilingual из коробки (ru/en/uk/de/fr/中文/...)
 *   - Zero deps (никакого wink-nlp / natural / @huggingface)
 *   - Детерминирован: одинаковый вход → одинаковый выход
 *   - Идемпотентен: повторное применение возвращает тот же результат
 */

export interface TokenizeOptions {
  /** Минимальная длина токена (включительно). Default: 2. */
  minLen?: number;
  /** Максимальная длина токена (включительно). Default: 64.
   *  Защита от мусорных «слов» вроде base64-блобов. */
  maxLen?: number;
  /** Lowercase нормализация. Default: true. */
  lowercase?: boolean;
}

const DEFAULT_MIN = 2;
const DEFAULT_MAX = 64;

/**
 * Низкоуровневый Unicode-aware tokenizer.
 *
 * Возвращает массив токенов (с возможными дубликатами — caller сам решает,
 * нужны ли уникальные через Set/Map).
 *
 * Регулярка `\p{L}\p{N}` использует Unicode property escapes (требует
 * флаг `u`). `\p{L}` = любая буква (Latin, Cyrillic, Greek, ...),
 * `\p{N}` = любая цифра (включая non-Latin numerals). Всё остальное —
 * пунктуация, whitespace, emoji, math symbols — становится разделителем.
 */
export function unicodeTokenize(text: string, opts: TokenizeOptions = {}): string[] {
  if (!text || typeof text !== "string") return [];

  const minLen = opts.minLen ?? DEFAULT_MIN;
  const maxLen = opts.maxLen ?? DEFAULT_MAX;
  const lowercase = opts.lowercase !== false;

  const source = lowercase ? text.toLowerCase() : text;
  const parts = source.split(/[^\p{L}\p{N}]+/u);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length >= minLen && p.length <= maxLen) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Уникальные токены в Set — для path / filename matching, similarity scoring.
 * Default minLen=3 (короткие токены типа "of", "ru" редко полезны для match).
 */
export function tokenizeToSet(text: string, opts: TokenizeOptions = {}): Set<string> {
  return new Set(unicodeTokenize(text, { minLen: 3, ...opts }));
}

/**
 * Token similarity by intersection over union — для name/path matching.
 *
 * Возвращает [0, 1]: 1 = идеальное совпадение токенов (с учётом порядка
 * и регистра, но без учёта повторов), 0 = ни одного общего.
 *
 * Используется для дедупа кандидатов импорта (имя файла vs imported title).
 */
export function nameTokenSimilarity(a: string, b: string): number {
  const left = tokenizeToSet(a);
  const right = tokenizeToSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) hits += 1;
  }
  return hits / Math.max(left.size, right.size);
}
