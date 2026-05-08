/**
 * PdfPageExtractor — адаптер уже растеризованной страницы PDF в `TextExtractor`
 * для Universal Cascade.
 *
 * АРХИТЕКТУРНОЕ МЕСТО (план smart-import-pipeline.md, Контур 4):
 *   Tier 0 (text-layer) — НЕ применим тут: текстовый слой PDF извлекается
 *     до cascade в `parsePdfMain` через pdfjs (`textContent.items`). Если он
 *     дал > 0 параграфов — cascade вообще не запускается. Это значит сюда мы
 *     попадаем только когда страница имиджевая (scanned PDF, или гибридный
 *     PDF без текстового слоя).
 *
 *   Tier 1 (system-ocr) — Windows.Media.Ocr / macOS Vision через
 *     `@napi-rs/system-ocr`. Бесплатно, работает на устройстве. На Linux вернёт
 *     null → cascade перейдёт к Tier 2.
 *
 *   Tier 2 (vision-llm) — `recognizeWithVisionLlm` через LM Studio. Уже
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
  ExtractOptions,
  ExtractionAttempt,
  TextExtractor,
} from "../extractors/types.js";
import { MAX_OCR_WARNING_LEN } from "../extractors/types.js";
import { isOcrSupported, recognizeImageBuffer } from "../ocr/index.js";
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
