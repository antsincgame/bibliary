/**
 * ImageFileExtractor — адаптер одиночного файла-изображения в `TextExtractor`
 * для Universal Cascade.
 *
 * АРХИТЕКТУРНОЕ МЕСТО (план smart-import-pipeline.md, Контур 4):
 *   Tier 0  (text-layer) — НЕ применим: у изображения нет текстового слоя.
 *
 *   Tier 1a (tesseract) — Tesseract.js + bundled rus/ukr/eng tessdata.
 *     CPU OCR, solid Cyrillic из коробки (Win.Media.Ocr с mixed-language
 *     input берёт только первый язык — даёт latin homoglyphs для русского).
 *     ~3s/image, без зависимости от GPU/vision-LLM.
 *
 *   Tier 1b (system-ocr) — `recognizeImageFile` через @napi-rs/system-ocr.
 *     Работает напрямую с файлом (без чтения в Buffer), что эффективнее для
 *     больших TIFF/PNG. Если ОС не поддерживается — null, cascade к Tier 2.
 *
 *   Tier 2  (vision-llm) — `recognizeWithVisionLlm` через LM Studio. Требует
 *     Buffer, поэтому мы читаем файл лениво только если до Tier 2 дошло.
 *     Vision-OCR обёрнут в scheduler heavy lane (см. Иt 8В MAIN.1.1).
 *
 * ИСПОЛЬЗУЕТСЯ:
 *   - `image.ts` (single-page PNG/JPG/TIFF/WebP)
 *   - В будущем — single-page внутри cbz/cbr, если понадобится cascade.
 *
 * НЕ ИСПОЛЬЗУЕТСЯ:
 *   - Multi-page TIFF — конвертится в PDF и идёт через pdf parser cascade.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  ExtractionAttempt,
  TextExtractor,
} from "../extractors/types.js";
import { MAX_OCR_WARNING_LEN } from "../extractors/types.js";
import { isOcrSupported, recognizeImageFile } from "../ocr/index.js";
import { isTesseractAvailable, recognizeWithTesseract } from "../ocr/tesseract.js";
import { recognizeWithVisionLlm } from "../_vendor/llm/vision-ocr.js";
import { scoreTextQuality } from "../extractors/quality-heuristic.js";

/**
 * Создаёт `TextExtractor` для одиночного файла-изображения.
 *
 * @param filePath абсолютный путь к изображению (PNG/JPG/BMP/TIFF/WebP).
 *                 Этот же путь будет передан в Cascade Runner как srcPath.
 */
export function createImageFileExtractor(filePath: string): TextExtractor {
  const baseName = path.basename(filePath);
  return {
    /* Tier 0 не определяем — у изображения нет текстового слоя. */

    async tryTesseract(_srcPath, opts): Promise<ExtractionAttempt | null> {
      if (!isTesseractAvailable()) return null;
      let buffer: Buffer;
      try {
        /* Tesseract API требует Buffer/Uint8Array. recognizeImageFile (system-ocr)
           работает с filePath напрямую и в этом плане эффективнее, но тут
           мы читаем lazy: только если Tier 1a реально вызывается. Cascade
           Runner не дойдёт до Tier 1a если Tier 0 (n/a) или Tier 1a уже
           отменён через disabledTiers. */
        buffer = await fs.readFile(filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          tier: 1,
          engine: "tesseract",
          quality: 0,
          text: "",
          warnings: [`tesseract could not read ${baseName}: ${msg.slice(0, MAX_OCR_WARNING_LEN)}`],
        };
      }
      try {
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const result = await recognizeWithTesseract(bytes, {
          languages: opts.languages,
          signal: opts.signal,
        });
        const text = result.text.trim();
        return {
          tier: 1,
          engine: "tesseract",
          quality: result.confidence,
          text,
          warnings: [],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          tier: 1,
          engine: "tesseract",
          quality: 0,
          text: "",
          warnings: [`tesseract threw on ${baseName}: ${msg.slice(0, MAX_OCR_WARNING_LEN)}`],
        };
      }
    },

    async tryOsOcr(_srcPath, opts): Promise<ExtractionAttempt | null> {
      if (!isOcrSupported()) return null;
      try {
        /* Audit fix (post-Иt 8В /omnissiah): пробрасываем opts.signal — без этого
           Cancel импорта не прерывал долгий OS OCR на больших TIFF/PNG. */
        const result = await recognizeImageFile(
          filePath,
          opts.languages ?? [],
          "accurate",
          opts.signal,
        );
        const text = result.text.trim();
        const quality = scoreTextQuality(text);
        return {
          tier: 1,
          engine: "system-ocr",
          quality,
          text,
          warnings: [],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          tier: 1,
          engine: "system-ocr",
          quality: 0,
          text: "",
          warnings: [`system-ocr threw on ${baseName}: ${msg.slice(0, MAX_OCR_WARNING_LEN)}`],
        };
      }
    },

    async tryVisionLlm(_srcPath, opts): Promise<ExtractionAttempt | null> {
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          tier: 2,
          engine: "vision-llm",
          quality: 0,
          text: "",
          warnings: [`vision-llm could not read ${baseName}: ${msg.slice(0, MAX_OCR_WARNING_LEN)}`],
        };
      }
      const result = await recognizeWithVisionLlm(buffer, {
        languages: opts.languages,
        signal: opts.signal,
        modelKey: opts.visionOcrModel,
      });
      const text = result.text.trim();
      if (!text) {
        return {
          tier: 2,
          engine: "vision-llm",
          quality: 0,
          text: "",
          warnings: [`vision-llm failed on ${baseName}: ${result.error ?? "no text returned"}`],
        };
      }
      return {
        tier: 2,
        engine: "vision-llm",
        quality: result.confidence,
        text,
        warnings: [],
      };
    },
  };
}
