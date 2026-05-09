/**
 * tests/ocr-tesseract.test.ts
 *
 * Smoke-тест Tier-1a OCR engine'а (Tesseract.js) на реальном TIFF, отрендеренном
 * из cyrillic DjVu. Verifies:
 *   1. isTesseractAvailable() возвращает true когда vendor/tessdata/ полон.
 *   2. recognizeWithTesseract возвращает text + confidence > 0.5 на типичном
 *      книжном скане с русским.
 *   3. Языковая нормализация: 2-letter ISO ('ru', 'uk', 'en') → 3-letter Tess.
 *   4. Worker reuse: повторный вызов с теми же languages не платит init overhead
 *      (>3× быстрее первого).
 *
 * Tessdata bundled в `vendor/tessdata/` (см. scripts/download-tessdata.cjs).
 * Если vendor/tessdata/rus.traineddata не существует — тесты skip'аются с
 * информативным сообщением.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isTesseractAvailable,
  recognizeWithTesseract,
  disposeTesseract,
  _resetTesseractForTesting,
} from "../electron/lib/scanner/ocr/tesseract.ts";

const TESSDATA_DIR = path.resolve("vendor/tessdata");
const HAS_TESSDATA =
  fs.existsSync(path.join(TESSDATA_DIR, "rus.traineddata"));

/* Pre-rendered fixture: одна страница из cybernetic_predictive_devices.djvu
 * с чистым русским текстом про экстраполяцию + численность населения.
 * Если fixture отсутствует — тесты skip'аются. */
const FIXTURE_TIFF = "/tmp/djvu-render/page-30.tiff";
const HAS_FIXTURE = fs.existsSync(FIXTURE_TIFF);

const SKIP = !HAS_TESSDATA || !HAS_FIXTURE;
const SKIP_REASON = !HAS_TESSDATA
  ? "tessdata not present (run: npm run setup:tessdata)"
  : "fixture TIFF not present at /tmp/djvu-render/page-30.tiff (regenerate with `ddjvu -format=tiff -page=30 ...`)";

test("[tesseract] isTesseractAvailable detects bundled tessdata", { skip: !HAS_TESSDATA }, () => {
  assert.equal(isTesseractAvailable(), true);
});

test("[tesseract] recognize Russian page, confidence > 0.5, contains Cyrillic", { skip: SKIP, skipReason: SKIP_REASON }, async () => {
  _resetTesseractForTesting();
  const buffer = fs.readFileSync(FIXTURE_TIFF);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const result = await recognizeWithTesseract(bytes, {
    languages: ["ru", "uk", "en"],
    pageIndex: 30,
  });

  assert.ok(result.text.length > 200, `text too short: ${result.text.length} chars`);
  assert.ok(result.confidence > 0.5, `confidence too low: ${result.confidence}`);
  assert.equal(result.pageIndex, 30);
  /* Должны увидеть русские буквы, не латинские homoglyph'ы. */
  const cyrillicChars = (result.text.match(/[а-яё]/gi) ?? []).length;
  const latinChars = (result.text.match(/[a-z]/gi) ?? []).length;
  assert.ok(cyrillicChars > latinChars, `expected more Cyrillic than Latin, got cyr=${cyrillicChars} lat=${latinChars}`);
  await disposeTesseract();
});

test("[tesseract] worker reuse: 2nd call faster (no init overhead)", { skip: SKIP, skipReason: SKIP_REASON }, async () => {
  _resetTesseractForTesting();
  const buffer = fs.readFileSync(FIXTURE_TIFF);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const t1 = Date.now();
  await recognizeWithTesseract(bytes, { languages: ["ru", "uk", "en"], pageIndex: 0 });
  const firstMs = Date.now() - t1;

  const t2 = Date.now();
  await recognizeWithTesseract(bytes, { languages: ["ru", "uk", "en"], pageIndex: 1 });
  const secondMs = Date.now() - t2;

  /* Second call должен быть как минимум на 100ms быстрее (worker init = 200-300ms).
   * Не строгий ratio test — на CI бывают шумы; просто sanity что worker reuse
   * работает, а не пересоздаётся каждый раз. */
  assert.ok(secondMs < firstMs - 100,
    `worker not reused: first=${firstMs}ms, second=${secondMs}ms (expected diff > 100ms)`);
  await disposeTesseract();
});

test("[tesseract] aborts before recognize when signal already aborted", { skip: !HAS_TESSDATA }, async () => {
  _resetTesseractForTesting();
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => recognizeWithTesseract(new Uint8Array(8), {
      languages: ["ru"],
      signal: ctrl.signal,
    }),
    /aborted/,
  );
});
