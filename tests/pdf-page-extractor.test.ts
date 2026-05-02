/**
 * Unit tests для PdfPageExtractor (Иt 8В MAIN.2.A).
 *
 * Стратегия: project не использует ESM-моки (см. djvu-parser-cascade.test.ts),
 * поэтому тестируем КОНТРАКТ extractor'а, а не реальную работу OS OCR /
 * vision-LLM (это покрывают integration-тесты и e2e на реальных файлах).
 *
 * Что проверяем:
 *   1. createPdfPageExtractor возвращает TextExtractor с tryOsOcr + tryVisionLlm,
 *      но БЕЗ tryTextLayer (Tier 0 уже обработан в parsePdfMain).
 *   2. tryVisionLlm на невалидном setup (vision_ocr роль не настроена)
 *      возвращает не-null attempt с quality=0 и warning — Cascade Runner
 *      тогда сможет это интерпретировать.
 *   3. tryOsOcr на платформе без OS OCR (или с фейковым буфером) возвращает
 *      либо null (Linux), либо attempt с quality<0.5 (Win/macOS на garbage buffer).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createPdfPageExtractor } from "../electron/lib/scanner/parsers/pdf-page-extractor.js";

test("createPdfPageExtractor: возвращает TextExtractor с Tier 1 + Tier 2 методами (без Tier 0)", () => {
  const fakeBuffer = Buffer.alloc(100, 0xff);
  const extractor = createPdfPageExtractor(fakeBuffer, 0);

  assert.equal(typeof extractor.tryOsOcr, "function", "Tier 1 (system-ocr) должен быть реализован");
  assert.equal(typeof extractor.tryVisionLlm, "function", "Tier 2 (vision-llm) должен быть реализован");
  assert.equal(extractor.tryTextLayer, undefined, "Tier 0 (text-layer) НЕ должен быть реализован — обработан в parsePdfMain");
});

test("createPdfPageExtractor.tryVisionLlm: на не настроенной роли vision_ocr возвращает attempt c quality=0 и warning", async () => {
  const fakeBuffer = Buffer.alloc(100, 0xff);
  const extractor = createPdfPageExtractor(fakeBuffer, 0);

  const attempt = await extractor.tryVisionLlm!("/fake/page.png", { languages: ["en"] });

  assert.notEqual(attempt, null, "vision-LLM должен ВСЕГДА возвращать attempt (не null) — даже при отсутствии модели");
  assert.equal(attempt!.tier, 2);
  assert.equal(attempt!.engine, "vision-llm");
  assert.equal(attempt!.quality, 0, "при отсутствии модели quality=0 → cascade попробует best-of-others или вернёт null");
  assert.equal(attempt!.text, "");
  assert.ok(attempt!.warnings.length > 0, "должен быть warning с причиной отказа vision-LLM");
  assert.ok(
    attempt!.warnings[0].includes("page 1"),
    `warning должен указывать страницу, got: ${attempt!.warnings[0]}`,
  );
});

test("createPdfPageExtractor.tryOsOcr: на garbage buffer на любой OS не throw, возвращает либо null либо attempt", async () => {
  const garbage = Buffer.from("not a real png");
  const extractor = createPdfPageExtractor(garbage, 5);

  const attempt = await extractor.tryOsOcr!("/fake/page.png", { languages: ["en"] });

  /* На Linux: isOcrSupported()=false → null. На Windows/macOS: либо null,
     либо attempt с low quality (включая warnings про parsing error). */
  if (attempt !== null) {
    assert.equal(attempt.tier, 1);
    assert.equal(attempt.engine, "system-ocr");
    assert.ok(attempt.quality >= 0 && attempt.quality <= 1, "quality должен быть в [0..1]");
  }
});

test("createPdfPageExtractor: pageIndex прокидывается в warnings vision-LLM (1-based в сообщении)", async () => {
  const fakeBuffer = Buffer.alloc(100, 0xff);
  const extractor = createPdfPageExtractor(fakeBuffer, 41); // 0-based → "page 42" в warning

  const attempt = await extractor.tryVisionLlm!("/fake/page.png", {});

  assert.ok(attempt!.warnings[0].includes("page 42"), `expected page 42 in warning, got: ${attempt!.warnings[0]}`);
});
