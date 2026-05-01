/**
 * Quality Heuristic — оценка «полезности» извлечённого текста.
 *
 * Используется Cascade Runner'ом для решения «принять Tier и остановить каскад
 * vs попробовать следующий Tier». Также возвращается в кеш OCR (см. ocr-cache.ts)
 * чтобы caller мог принять решение «retry с другим engine».
 *
 * isQualityText — boolean быстрая проверка (порог 0.5 эквивалентно).
 * scoreTextQuality — числовая оценка 0..1 для tie-break и сохранения в кеш.
 *
 * Эвристики основаны на 4 сигналах:
 *   1. Минимальная длина 200 символов (короткий текст ничего не доказывает)
 *   2. Доля букв (Unicode \p{L}) — отсекает символьный мусор `@#$%^&*`
 *   3. Минимум 50 «слов» длиной 2..30 символов (отсекает рандомные хеши и one-word гигантов)
 *   4. Средняя длина слова в диапазоне [2..15] (норма для человеческих языков)
 *
 * Покрытие unit-тестами: tests/quality-heuristic.test.ts (16 кейсов).
 */

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
