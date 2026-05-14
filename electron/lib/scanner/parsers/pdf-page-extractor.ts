/**
 * PdfPageExtractor — адаптер уже растеризованной страницы PDF в `TextExtractor`
 * для Universal Cascade.
 *
 * АРХИТЕКТУРНОЕ МЕСТО (план smart-import-pipeline.md, Контур 4):
 *   Tier 0  (text-layer) — НЕ применим тут: текстовый слой PDF извлекается
 *     до cascade в `parsePdfMain` через pdfjs (`textContent.items`). Если он
 *     дал > 0 параграфов — cascade вообще не запускается. Это значит сюда мы
 *     попадаем только когда страница имиджевая (scanned PDF, или гибридный
 *     PDF без текстового слоя).
 *
 *   Tier 1a (tesseract) — Tesseract.js + bundled rus/ukr/eng tessdata.
 *     CPU-only, ~3s/page. Главный мотив — solid Cyrillic на Win/Mac
 *     (Win.Media.Ocr с mixed-language input берёт ТОЛЬКО первый язык, выдаёт
 *     latin homoglyphs для русских букв — баг #4 в DjVu, тот же риск был
 *     для image-only PDF до этого фикса). Главный бенефициар — DjVu файлы
 *     без text-layer, идущие через convertDjvu→pdfParser cascade.
 *
 *   Tier 1b (system-ocr) — Windows.Media.Ocr / macOS Vision через
 *     `@napi-rs/system-ocr`. Быстрее Tesseract на коротких документах
 *     (нет init overhead). При нерасп. ОС → null, cascade к Tier 2.
 *
 *   Tier 2  (vision-llm) — `recognizeWithVisionLlm` через LM Studio. Уже
 *     обёрнут в `ImportTaskScheduler.enqueue("heavy")` (Иt 8В MAIN.1.1)
 *     для дросселирования VRAM-нагрузки. Confidence от vision-OCR
 *     прокидывается как quality в Cascade Runner.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ:
 *   pdf.ts — большой (>500 строк) с собственной spaghetti для outline/sections.
 *   Extractor живёт отдельно чтобы:
 *     1) тестировать в изоляции от pdfjs (нужен только Buffer)
 *     2) переиспользовать тот же подход в image.ts для single-page TIFF/PNG
 *     3) держать pdf.ts фокусированным на парсинге, а не на cascade-механике
 *
 * НЕ ИСПОЛЬЗУЕТ srcPath: страница — это Buffer, файловой системы здесь нет.
 * Параметр игнорируется (контракт TextExtractor требует его сигнатуру).
 */

import type {
  ExtractionAttempt,
  TextExtractor,
} from "../extractors/types.js";
import { MAX_OCR_WARNING_LEN } from "../extractors/types.js";
import { isOcrSupported, recognizeImageBuffer } from "../ocr/index.js";
import { isTesseractAvailable, recognizeWithTesseract } from "../ocr/tesseract.js";
import { recognizeWithVisionLlm } from "../../llm/vision-ocr.js";
import { scoreTextQuality } from "../extractors/quality-heuristic.js";

/**
 * Создаёт `TextExtractor` для одной уже растеризованной страницы PDF.
 *
 * @param pageBuffer PNG-буфер страницы (вывод `rasterisePdfPages`).
 * @param pageIndex 0-based индекс страницы — нужен `recognizeImageBuffer`
 *                  для diag/трассировки и для `ocr-cache` ключа.
 */
export function createPdfPageExtractor(
  pageBuffer: Buffer,
  pageIndex: number,
): TextExtractor {
  return {
    /* Tier 0 пропускаем — текстовый слой обработан в parsePdfMain до cascade.
       Если бы cascade встретил Tier 0 здесь, мы бы дублировали работу pdfjs. */

    async tryTesseract(_srcPath, opts): Promise<ExtractionAttempt | null> {
      /* Bundled tessdata отсутствует (custom build / dev mode без vendor/) →
         null, cascade переходит к Tier 1b system-ocr. */
      if (!isTesseractAvailable()) return null;
      try {
        /* Конвертируем Buffer → Uint8Array без копирования (Buffer extends
           Uint8Array, тот же ArrayBuffer). recognizeWithTesseract внутри
           делает обратное приведение к Buffer для tesseract.js контракта. */
        const bytes = new Uint8Array(
          pageBuffer.buffer,
          pageBuffer.byteOffset,
          pageBuffer.byteLength,
        );
        const result = await recognizeWithTesseract(bytes, {
          languages: opts.languages,
          pageIndex,
          signal: opts.signal,
        });
        const text = result.text.trim();
        /* Tesseract возвращает confidence в 0..1 (мы нормализуем в
           recognizeWithTesseract). Используем как quality напрямую — это
           согласуется с vision-llm Tier 2. scoreTextQuality игнорируем,
           потому что Tesseract уже даёт калиброванный confidence. */
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
          warnings: [`tesseract threw on page ${pageIndex + 1}: ${msg.slice(0, MAX_OCR_WARNING_LEN)}`],
        };
      }
    },

    async tryOsOcr(_srcPath, opts): Promise<ExtractionAttempt | null> {
      if (!isOcrSupported()) return null;
      try {
        const result = await recognizeImageBuffer(
          pageBuffer,
          pageIndex,
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
          warnings: [`system-ocr threw on page ${pageIndex + 1}: ${msg.slice(0, MAX_OCR_WARNING_LEN)}`],
        };
      }
    },

    async tryVisionLlm(_srcPath, opts): Promise<ExtractionAttempt | null> {
      const result = await recognizeWithVisionLlm(pageBuffer, {
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
          warnings: [
            `vision-llm failed on page ${pageIndex + 1}: ${result.error ?? "no text returned"}`,
          ],
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
