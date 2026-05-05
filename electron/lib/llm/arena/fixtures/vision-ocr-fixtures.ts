/**
 * Vision-OCR test fixtures для Олимпиады.
 *
 * PNG-картинки, отрисованные программно (Sharp + SVG) с известным
 * содержимым. Используются для дисциплин `vision_ocr-*` чтобы дать
 * VLM возможность набрать 90-100/100 (раньше fixture был пустой
 * красный квадрат → потолок 50/100).
 *
 * Регенерация: `node scripts/generate-vision-ocr-fixtures.cjs`.
 *
 * Важно: эти данные не должны меняться без обновления тестов
 * `tests/olympics-scorers.test.ts` (vision_ocr подсекция).
 */
import fixturesData from "./vision-ocr-fixtures.json";

export interface VisionOcrFixture {
  base64: string;
  sizeBytes: number;
  expectedTokens: string[];
  width: number;
  height: number;
  text: string;
}

const FIXTURES = fixturesData as Record<string, VisionOcrFixture>;

/** PNG c простым печатным текстом «THE QUICK BROWN FOX» (1 строка). */
export const VISION_OCR_SIMPLE = FIXTURES.ocr_simple_print;
/** 2 строки: «Hello World» + «2024-12-25» — текст и числа с дефисами. */
export const VISION_OCR_TWO_LINES = FIXTURES.ocr_two_lines;
/** Сложный fixture: «INVOICE #4291» + «Total: $1,234.56» — числа, символы. */
export const VISION_OCR_NUMBERS = FIXTURES.ocr_numbers_dense;
/** Контрольный пустой PNG — модель должна сказать NO_TEXT. */
export const VISION_OCR_BLANK = FIXTURES.ocr_blank_no_text;
/**
 * v1.0.10 (2026-05-06): scan страницы из учебника В.А. Зорича
 * «Математический анализ» (мелкий русский шрифт + математические символы:
 * ∪ ∩ ∈ ⊂ × → = > <). 566×731 px, ~294 KB.
 *
 * Используется в дисциплине `vision_ocr-ru-math-textbook` для тестирования
 * VLM на:
 *   1) кириллице (русский язык);
 *   2) мелком плотном тексте (~30 строк / 7000 символов);
 *   3) Unicode-математических символах (теории множеств + функций);
 *   4) типографических знаках (—, :, ;, скобки).
 *
 * Эталонные токены покрывают ключевые понятия из текста + math operators.
 * Это эталон «реального производственного OCR» — намного сложнее чем
 * «THE QUICK BROWN FOX» fixtures выше.
 */
export const VISION_OCR_RU_MATH = FIXTURES.ocr_ru_math_textbook;

export function asImageDataUrl(fixture: VisionOcrFixture): string {
  return `data:image/png;base64,${fixture.base64}`;
}
