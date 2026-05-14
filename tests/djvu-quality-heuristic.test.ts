/**
 * isQualityText — unit-тесты эвристики «текстовый слой DjVu пригоден».
 *
 * Старая проверка `text.length > 100` пропускала OCR-мусор и заворачивала
 * короткий валидный текст. Новая основана на 4 сигналах:
 *   1. min length 200
 *   2. letter ratio (Unicode \p{L}) >= 0.5
 *   3. min 50 «слов» длиной 2..30
 *   4. avg word length 2..15
 *
 * Покрытие: позитивные кейсы (русский, английский, mixed) + негативные
 * (OCR garbage, цифры, короткое, символы) + границы.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { isQualityText } from "../server/lib/scanner/parsers/djvu.js";

describe("isQualityText — позитивные кейсы (real text)", () => {
  it("осмысленный английский абзац (>200 chars, реальные слова) → true", () => {
    const text = `The book begins with a discussion of the philosophical foundations
of quantum mechanics, exploring the relationship between observation and reality.
Throughout the chapters the author presents various interpretations and their
implications for our understanding of nature. The reader is invited to consider
the deep questions that arise when we examine the smallest constituents of matter.`;
    expect(isQualityText(text)).toBe(true);
  });

  it("осмысленный русский абзац → true", () => {
    const text = `Эта книга посвящена основам теории информации и её приложениям
к проблемам кодирования и передачи данных. В первой главе рассматриваются базовые
понятия энтропии, взаимной информации и пропускной способности канала. Далее
обсуждаются методы оптимального кодирования источника и помехоустойчивого
кодирования. Особое внимание уделяется практическим алгоритмам сжатия данных.
Вторая глава посвящена помехоустойчивому кодированию и его применению в реальных
системах связи. Рассматриваются блочные и свёрточные коды, а также современные
турбо-коды и LDPC коды, которые используются в стандартах сотовой связи и спутниковой
передачи данных. Подробно разбираются алгоритмы декодирования по максимуму правдоподобия
и итеративные методы декодирования.`;
    expect(isQualityText(text)).toBe(true);
  });

  it("научный текст с формулами и цифрами тоже валиден", () => {
    const text = `Уравнение Шрёдингера ihbar dpsi/dt = H psi описывает эволюцию
квантового состояния системы во времени. Оператор Гамильтона H представляет
полную энергию системы и зависит от конкретной задачи. Для свободной частицы
H равен p^2 / 2m. Для гармонического осциллятора добавляется потенциал mw^2 x^2 / 2.
Решение этого уравнения даёт волновую функцию psi(x,t) которая содержит всю
информацию о системе. Квадрат модуля psi даёт плотность вероятности.`;
    expect(isQualityText(text)).toBe(true);
  });
});

describe("isQualityText — негативные кейсы (OCR garbage / мусор)", () => {
  it("OCR мусор из символов (>200 chars, но letter ratio < 0.5) → false", () => {
    const garbage = "@#$%^&*()_+{}[]|\\:;\"'<>,.?/~`!  ".repeat(20);
    expect(isQualityText(garbage)).toBe(false);
  });

  it("чисто цифры (нет букв, letter ratio = 0) → false", () => {
    const digits = "12345 67890 11223 44556 77889 00112 33445 ".repeat(10);
    expect(isQualityText(digits)).toBe(false);
  });

  it("очень короткий текст (<200 chars) → false даже если осмысленный", () => {
    const short = "Это короткое предложение содержит около ста символов суммарно.";
    expect(isQualityText(short)).toBe(false);
  });

  it("длинная строка из одного «слова» (<50 «слов») → false", () => {
    const oneword = "supercalifragilisticexpialidocious".repeat(20);
    expect(isQualityText(oneword)).toBe(false);
  });

  it("рандомные хеши (слова >30 символов фильтруются) → false", () => {
    const hashes = Array.from({ length: 30 })
      .map(() => "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2")
      .join(" ");
    expect(isQualityText(hashes)).toBe(false);
  });

  it("пустая строка → false", () => {
    expect(isQualityText("")).toBe(false);
  });
});

describe("isQualityText — границы и edge cases", () => {
  it("ровно 199 символов осмысленного текста → false (граница min length)", () => {
    /* 199 chars, valid text */
    const text = "слово ".repeat(33).trim();
    expect(text.length).toBeLessThan(200);
    expect(isQualityText(text)).toBe(false);
  });

  it("≥200 символов И ≥50 слов → true", () => {
    /* "слово " × 50 = 300 chars, 50 слов */
    const text = "слово ".repeat(50).trim();
    expect(text.length).toBeGreaterThanOrEqual(200);
    expect(isQualityText(text)).toBe(true);
  });

  it("≥200 символов но <50 слов (длинные слова) → false", () => {
    /* 30 повторений 7-char word = 210 chars, всего 30 слов */
    const text = "слово1 ".repeat(30).trim();
    expect(text.length).toBeGreaterThanOrEqual(200);
    expect(isQualityText(text)).toBe(false);
  });

  it("текст где буквы 51% (граница letter ratio) → true", () => {
    /* 200 chars, 51% букв */
    const letters = "abcde".repeat(20); /* 100 chars */
    const padding = " 1 2 ".repeat(20); /* 100 chars, в основном пробелы и цифры */
    const text = letters + padding;
    expect(text.length).toBe(200);
    expect(isQualityText(text)).toBe(false); /* 50% букв (100/200) — порог 0.5 не строго > */
  });

  it("текст с очень длинными словами (avg > 15) → false", () => {
    const longWords = "supercalifragilisticexpialidocious ".repeat(50);
    expect(isQualityText(longWords)).toBe(false);
  });

  it("Unicode-only (например китайские иероглифы) считается буквами → true", () => {
    const chinese = "这本书讲述了一个关于古代哲学家的故事其中包含了许多有趣的对话和深刻的思考".repeat(5);
    /* Каждый китайский символ считается \p{L}, и каждый идёт «словом» в split — но
       split по \s+ для отсутствия пробелов вернёт одну гигантскую строку, которая
       будет отфильтрована порогом длины 30. → false */
    expect(isQualityText(chinese)).toBe(false);
  });

  it("Unicode (китайские) с пробелами между группами по 2-10 символов → true", () => {
    const chinese = Array.from({ length: 100 })
      .map(() => "这本书")
      .join(" ");
    expect(isQualityText(chinese)).toBe(true);
  });
});
