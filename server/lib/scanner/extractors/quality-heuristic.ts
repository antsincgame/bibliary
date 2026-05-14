/**
 * Quality Heuristic — оценка «полезности» извлечённого текста.
 *
 * Используется Cascade Runner'ом для решения «принять Tier и остановить каскад
 * vs попробовать следующий Tier». Также возвращается в кеш OCR (см. ocr-cache.ts)
 * чтобы caller мог принять решение «retry с другим engine».
 *
 * isQualityText — boolean быстрая проверка (порог 0.5 эквивалентно).
 * scoreTextQuality — числовая оценка 0..1 для tie-break и сохранения в кеш.
 * detectLatinCyrillicConfusion — detects OCR garble where Latin homoglyphs or
 *   digit substitutions corrupt Cyrillic text (safe for Ukrainian і/ї characters).
 *
 * Эвристики основаны на 4 сигналах:
 *   1. Минимальная длина 200 символов (короткий текст ничего не доказывает)
 *   2. Доля букв (Unicode \p{L}) — отсекает символьный мусор `@#$%^&*`
 *   3. Минимум 50 «слов» длиной 2..30 символов (отсекает рандомные хеши и one-word гигантов)
 *   4. Средняя длина слова в диапазоне [2..15] (норма для человеческих языков)
 *
 * Покрытие unit-тестами: tests/quality-heuristic.test.ts (16 кейсов).
 */

// ─── Latin-Cyrillic confusion detection ──────────────────────────────────────

/**
 * Result of OCR confusion analysis.
 *
 * "Confusion" means the OCR engine produced a mix of Latin homoglyphs and
 * Cyrillic characters within the same words, or used digits as letter
 * substitutes — a classic DjVu text-layer artefact from FineReader/ABBYY
 * running without a Cyrillic language model.
 */
export interface ConfusionResult {
  /** True when confusion is detected at or above the configured threshold. */
  isConfused: boolean;
  /** Number of tokens (words) with embedded Latin homoglyphs in Cyrillic context. */
  homoglyphTokens: number;
  /** Number of patterns where digits substitute Cyrillic/Latin letters (e.g. 06pa3y). */
  digitSubstitutions: number;
  /** Total tokens examined. */
  sampleTokens: number;
}

/**
 * Latin characters that are visual homoglyphs of Cyrillic letters and therefore
 * cause real confusion in OCR output.  `i` (U+0069) and `ï` (U+00EF) are
 * intentionally ABSENT: Ukrainian OCR commonly produces them for і (U+0456) and
 * ї (U+0457) without creating confusion.
 *
 * Lowercase: p→р, c→с, o→о, a→а, e→е, x→х, y→у
 * Uppercase: P→Р, C→С, O→О, A→А, E→Е, X→Х, B→В, H→Н, M→М, T→Т, K→К
 */
const LATIN_HOMOGLYPHS = new Set<string>([
  "p", "c", "o", "a", "e", "x", "y",
  "P", "C", "O", "A", "E", "X", "B", "H", "M", "T", "K",
]);

/**
 * Detects Latin-Cyrillic OCR confusion in a text sample.
 *
 * Two signals are measured:
 *
 * 1. **Homoglyph tokens** — words that contain both Cyrillic letters (≥ 3) AND
 *    at least one Latin homoglyph from LATIN_HOMOGLYPHS. `i`/`ï` are whitelisted
 *    so valid Ukrainian text is not flagged.
 *
 * 2. **Digit substitutions** — tokens where a digit appears in between
 *    Cyrillic/Latin letters in a way that implies letter-for-digit swap
 *    (e.g. `06pa3y`, `cт6oл`, `зa6op`). Pattern: Cyrillic char, then digit(s),
 *    then a letter, within the same "word" (no spaces).
 *
 * Confusion is declared when the combined rate exceeds the threshold:
 *   (homoglyphTokens + digitSubstitutions * 2) / max(sampleTokens, 1) > 0.03
 * OR when the absolute count is >= 5 (catches short pages with dense garble).
 */
export function detectLatinCyrillicConfusion(text: string): ConfusionResult {
  const tokens = text.split(/\s+/).filter((t) => t.length >= 3);
  const sampleTokens = tokens.length;

  let homoglyphTokens = 0;
  let digitSubstitutions = 0;
  /* v1.1.2 Bug #4: mixed-script tokens — слова с ≥2 кириллических И ≥1
     латинской буквой (любой, не только из homoglyph-списка), исключая
     i/I (украинский whitelist). Ловит случаи типа `бdня`, `пgaшcт` где
     OCR подставил случайные latin chars, не входящие в LATIN_HOMOGLYPHS. */
  let mixedScriptTokens = 0;

  // Regex for digit-substitution: a Cyrillic char adjacent to a digit adjacent to a letter
  const DIGIT_SUB_RE = /[\u0400-\u04ff][0-9]+[a-zA-Z\u0400-\u04ff]|[a-zA-Z\u0400-\u04ff][0-9]+[\u0400-\u04ff]/u;

  for (const token of tokens) {
    // Count Cyrillic chars (excluding digits, Latin, punctuation)
    let cyrillicCount = 0;
    let suspiciousLatinCount = 0;
    let anyLatinCount = 0;
    for (const ch of token) {
      const code = ch.charCodeAt(0);
      if (code >= 0x0400 && code <= 0x04ff) cyrillicCount++;
      else if (LATIN_HOMOGLYPHS.has(ch)) suspiciousLatinCount++;
      if (
        ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
        && code !== 0x49 /* I */
        && code !== 0x69 /* i */
      ) {
        anyLatinCount++;
      }
    }

    if (cyrillicCount >= 3 && suspiciousLatinCount >= 1) {
      homoglyphTokens++;
    } else if (cyrillicCount >= 2 && anyLatinCount >= 1) {
      mixedScriptTokens++;
    }

    if (DIGIT_SUB_RE.test(token)) {
      digitSubstitutions++;
    }
  }

  /* Char-frequency heuristic: на OCR-textах с систематической homoglyph-
   * подменой общая частота латиницы возрастает аномально. В чистом русском
   * тексте Latin letters обычно <2% (иностранные термины "API", "iPhone").
   *
   * Украинский edge case: буква `і` нередко представлена как Latin `i` —
   * это legitimate (одинаковая глифа), не OCR-error. Исключаем `i/I` из
   * подсчёта чтобы не false-trigger на украинских текстах.
   *
   * Threshold 0.05 (5%) подобран чтобы пройти normal текст с одиночными
   * терминами но flagить systemic подмену (типичные homoglyph-OCR кейсы:
   * 15-30% chars). Upper bound 0.40 — выше это просто английский текст. */
  let totalCyrillic = 0;
  let totalSuspectLatin = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0400 && code <= 0x04ff) totalCyrillic++;
    else if (
      ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
      && code !== 0x49 /* I */
      && code !== 0x69 /* i */
    ) {
      totalSuspectLatin++;
    }
  }
  const charRatio = totalCyrillic > 50 && totalSuspectLatin > 0
    ? totalSuspectLatin / (totalCyrillic + totalSuspectLatin)
    : 0;
  const charFreqAnomaly = totalCyrillic > 50 && charRatio > 0.05 && charRatio < 0.40;

  /* Adaptive abs threshold: для коротких текстов (одна страница, <50 токенов)
     достаточно 3 weighted hits — не ждём пока наберётся 5. Для длинных
     текстов 5 остаётся (это абсолютный signal что OCR systemically broken).
     mixedScriptTokens добавляются с весом 1 — менее уверенный сигнал чем
     homoglyph (закрытый список) или digitSub (структурный), но всё ещё
     значимый при системной подмене. */
  const weightedCount = homoglyphTokens + digitSubstitutions * 2 + mixedScriptTokens;
  const absThreshold = sampleTokens < 50 ? 3 : 5;
  const isConfused =
    weightedCount >= absThreshold ||
    (sampleTokens > 0 && weightedCount / sampleTokens > 0.03) ||
    charFreqAnomaly;

  return { isConfused, homoglyphTokens, digitSubstitutions, sampleTokens };
}

// ─── Text quality scoring ─────────────────────────────────────────────────────

const MIN_TEXT_LENGTH = 200;
const MIN_LETTER_RATIO = 0.5;
const MIN_WORD_COUNT = 50;
const MIN_WORD_LEN = 2;
const MAX_WORD_LEN = 30;
const MIN_AVG_WORD_LEN = 2;
const MAX_AVG_WORD_LEN = 15;

/**
 * Boolean проверка «текст пригодный, использовать без дополнительного OCR».
 *
 * Все четыре сигнала должны выполниться. False positive = принимаем мусор как
 * текст; false negative = делаем лишний OCR. Heuristic настроена в сторону
 * false negative (чуть чаще делаем OCR, чем чуть чаще пропускаем мусор) —
 * это правильная сторона ошибки для пользователя.
 */
export function isQualityText(text: string): boolean {
  return scoreTextQuality(text) >= 0.5;
}

/**
 * Числовая оценка 0..1.
 *
 * 0.0  — совсем не пригоден (короче порога, символьный мусор, рандомные хеши)
 * 0.5  — пограничный случай, лучше попробовать другой Tier
 * 0.7+ — уверенно полезный текст
 * 1.0  — идеальный, длинный, чисто буквенный, нормальная статистика слов
 */
export function scoreTextQuality(text: string): number {
  if (!text || text.length < MIN_TEXT_LENGTH) return 0;

  const letterMatches = text.match(/\p{L}/gu);
  const letterCount = letterMatches ? letterMatches.length : 0;
  const letterRatio = letterCount / text.length;
  if (letterRatio < MIN_LETTER_RATIO) return 0;

  const words = text.split(/\s+/).filter((w) => w.length >= MIN_WORD_LEN && w.length <= MAX_WORD_LEN);
  if (words.length < MIN_WORD_COUNT) return 0;

  const avgWordLen = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  if (avgWordLen < MIN_AVG_WORD_LEN || avgWordLen > MAX_AVG_WORD_LEN) return 0;

  /* Все 4 сигнала прошли — даём score выше порога 0.5.
     Значение масштабируется по «здоровью» текста:
       - letterRatio: 0.5 → 0.5, 1.0 → 1.0 (линейно)
       - длина: bonus до 0.1 если >= 1000 chars
       - количество слов: bonus до 0.1 если >= 200 слов
     Итог clamped в [0.5..1.0]. */
  let score = 0.5 + (letterRatio - 0.5);
  if (text.length >= 1000) score += 0.1;
  if (words.length >= 200) score += 0.1;
  return Math.min(1.0, Math.max(0.5, score));
}
