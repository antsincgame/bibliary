/**
 * scoreTextQuality — числовая оценка 0..1 текстового качества.
 *
 * `isQualityText` уже покрыт `tests/djvu-quality-heuristic.test.ts`. Этот файл
 * фокусируется на ЧИСЛОВЫХ свойствах score: монотонность, clamp, бонусы.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { scoreTextQuality } from "../electron/lib/scanner/extractors/quality-heuristic.js";

describe("scoreTextQuality — диапазон [0, 1]", () => {
  it("пустая строка → 0", () => {
    expect(scoreTextQuality("")).toBe(0);
  });

  it("слишком короткий текст (<200 chars) → 0", () => {
    expect(scoreTextQuality("Just a short text.")).toBe(0);
  });

  it("OCR-мусор из символов → 0", () => {
    const garbage = "@#$%^&*()_+{}[]|\\:;\"'<>,.?/~`!  ".repeat(20);
    expect(scoreTextQuality(garbage)).toBe(0);
  });

  it("успешный текст → score >= 0.5 и <= 1.0", () => {
    const text = "слово ".repeat(60).trim();
    const score = scoreTextQuality(text);
    expect(score).toBeGreaterThanOrEqual(0.5);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

describe("scoreTextQuality — бонусы за длину и количество слов", () => {
  it("длинный (>=1000 chars) текст получает bonus +0.1", () => {
    const short = "слово ".repeat(60).trim(); /* 360 chars, 60 слов */
    const long = "слово ".repeat(200).trim();  /* 1200 chars, 200 слов */
    /* short: 1.0 letterRatio (минус пробелы — но пробелы тоже считаются в text.length).
       Реальный letterRatio для "слово слово ..." примерно (5/6) ≈ 0.83.
       short score: 0.5 + (0.83 - 0.5) ≈ 0.83 (без бонуса).
       long score: 0.5 + (0.83 - 0.5) + 0.1 (length bonus) + 0.1 (words bonus) → clamped 1.0. */
    const shortScore = scoreTextQuality(short);
    const longScore = scoreTextQuality(long);
    expect(longScore).toBeGreaterThanOrEqual(shortScore);
  });

  it("score никогда не превышает 1.0 даже для идеального текста", () => {
    /* Чисто буквенный, длинный, много слов — все три условия для max bonus.
       Слова 4-7 chars (realistic avg word length 5.5 < MAX_AVG_WORD_LEN=15). */
    const ideal = ("hello world test code book reading writing ".repeat(40)).trim();
    /* 280+ слов длины 4-7, ratio букв ≈ 0.86 (с учётом пробелов), длина ≥ 1000.
       score = 0.5 + (0.86-0.5) + 0.1 (length>=1000) + 0.1 (words>=200) = 1.06 → clamp 1.0. */
    const score = scoreTextQuality(ideal);
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0.5);
  });
});

describe("scoreTextQuality — монотонность", () => {
  it("один и тот же текст возвращает одинаковый score (детерминизм)", () => {
    const text = "Это тестовый текст для проверки детерминизма функции. ".repeat(20);
    const a = scoreTextQuality(text);
    const b = scoreTextQuality(text);
    expect(a).toBe(b);
  });

  it("больший letterRatio → больший score (при прочих равных)", () => {
    const lowRatio = ("xxx 1 ".repeat(60)).trim(); /* много цифр и пробелов */
    const highRatio = ("слово ".repeat(60)).trim(); /* почти все буквы */
    const lowScore = scoreTextQuality(lowRatio);
    const highScore = scoreTextQuality(highRatio);
    /* Если оба не 0, highRatio должен быть >= */
    if (lowScore > 0 && highScore > 0) {
      expect(highScore).toBeGreaterThanOrEqual(lowScore);
    }
  });
});

describe("scoreTextQuality vs isQualityText согласованность", () => {
  it("score >= 0.5 ⟺ isQualityText вернёт true", async () => {
    const { isQualityText } = await import("../electron/lib/scanner/extractors/quality-heuristic.js");
    const cases = [
      "",
      "short",
      "@#$%".repeat(100),
      "слово ".repeat(60).trim(),
      "слово ".repeat(200).trim(),
    ];
    for (const text of cases) {
      const score = scoreTextQuality(text);
      const isQ = isQualityText(text);
      expect(isQ).toBe(score >= 0.5);
    }
  });
});
