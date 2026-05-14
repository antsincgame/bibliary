/**
 * TIFF parser-router — single-page → imageParser, multi-page → multi-tiff converter.
 *
 * Контекст (Iter 6В): TIFF файлы бывают двух типов:
 *   1. Single-page TIFF (большинство в реальных библиотеках, например 51 файл
 *      `04-05.tif`, `36-37.tif` в D:\Bibliarifull — convention "страница на файл").
 *      Идут через обычный `imageParser` → OS OCR.
 *   2. Multi-page TIFF (архивные сканы, факсимильные книги). Идут через
 *      `convertMultiTiff` → multi-page PDF → `pdfParser` → Universal Cascade
 *      (OS OCR Tier 1 → vision-LLM Tier 2).
 *
 * Этот wrapper заменяет imageParser для tif/tiff в PARSERS — runtime check
 * pages count определяет route. Для не-TIFF image форматов (png/jpg/bmp/webp/gif)
 * по-прежнему используется обычный imageParser напрямую.
 *
 * Variant C из 3 рассмотренных (A=image.ts patch, B=dispatcher runtime check,
 * C=отдельный wrapper) — выбран пользователем за полную separation of concerns.
 */

import * as path from "path";
import type { BookParser, ParseOptions, ParseResult } from "./types.js";
import { imageParser } from "./image.js";
import { convertMultiTiff, getTiffPageCount } from "../converters/multi-tiff.js";

async function parseTiff(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const baseName = path.basename(filePath, path.extname(filePath));
  const warnings: string[] = [];

  let pageCount: number;
  try {
    pageCount = await getTiffPageCount(filePath);
  } catch {
    /* Sharp недоступен или файл нечитаем — fallback на imageParser (тоже умеет
       graceful). Не throw тут, чтобы не сломать pipeline на отсутствующем sharp. */
    return imageParser.parse(filePath, opts);
  }

  if (pageCount <= 1) {
    /* Single-page TIFF — обычный OS OCR через imageParser (текущее поведение). */
    return imageParser.parse(filePath, opts);
  }

  /* Multi-page TIFF — конвертируем в PDF и делегируем pdfParser. */
  const conv = await convertMultiTiff(filePath, { signal: opts.signal });
  try {
    if (conv.kind === "text-extracted") {
      /* Sharp упал на extraction страниц или 0 успешных embed → fallback на
         imageParser (хоть страница 1 пройдёт через OS OCR). */
      warnings.push(...conv.warnings);
      warnings.push("multi-TIFF conversion failed, fallback to imageParser (page 1 only)");
      const fallback = await imageParser.parse(filePath, opts);
      return {
        ...fallback,
        metadata: {
          ...fallback.metadata,
          warnings: [...warnings, ...fallback.metadata.warnings],
        },
      };
    }

    /* delegate path → pdfParser. */
    const { pdfParser } = await import("./pdf.js");
    try {
      const result = await pdfParser.parse(conv.path, opts);
      warnings.push(`Converted multi-page TIFF (${pageCount} pages) to PDF and parsed via pdfParser`);
      if (conv.warnings.length > 0) warnings.push(...conv.warnings);
      return {
        metadata: {
          ...result.metadata,
          title: result.metadata.title || baseName,
          warnings: [...warnings, ...result.metadata.warnings],
        },
        sections: result.sections,
        rawCharCount: result.rawCharCount,
      };
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      warnings.push(`pdfParser failed on multi-TIFF-derived PDF: ${msg.slice(0, 200)}`);
      return {
        metadata: { title: baseName, warnings },
        sections: [],
        rawCharCount: 0,
      };
    }
  } finally {
    await conv.cleanup();
  }
}

export const tiffParser: BookParser = { ext: "tif", parse: parseTiff };
export const tiffAlternateParser: BookParser = { ext: "tiff", parse: parseTiff };
