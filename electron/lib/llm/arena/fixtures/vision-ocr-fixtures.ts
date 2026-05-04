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

export function asImageDataUrl(fixture: VisionOcrFixture): string {
  return `data:image/png;base64,${fixture.base64}`;
}
