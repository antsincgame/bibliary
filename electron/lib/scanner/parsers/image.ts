/**
 * Image parser: turns a PNG/JPG/etc into a single-section ParseResult by
 * running OS-native OCR. Produced sections feed the same chunker as PDF/EPUB.
 *
 * Phase 6.0 -- introduced together with OCR service.
 */

import * as path from "path";
import { promises as fs } from "fs";
import { isOcrSupported } from "../ocr/index.js";
import { cleanParagraph, type BookParser, type ParseOptions, type ParseResult } from "./types.js";
import { runExtractionCascade } from "../extractors/cascade-runner.js";
import { createImageFileExtractor } from "./image-file-extractor.js";

async function parseImage(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const baseName = path.basename(filePath, path.extname(filePath));

  /* Без OS OCR и без vision-LLM модели — нечем парсить изображение. */
  const visionConfigured = Boolean(opts.visionModelKey);
  if (!isOcrSupported() && !visionConfigured) {
    return {
      metadata: {
        title: baseName,
        warnings: ["Image OCR is unavailable: OS OCR not supported and no vision-LLM model configured."],
      },
      sections: [],
      rawCharCount: 0,
    };
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    return {
      metadata: { title: baseName, warnings: [`stat failed: ${(err as Error).message}`] },
      sections: [],
      rawCharCount: 0,
    };
  }
  if (stat.size === 0) {
    return {
      metadata: { title: baseName, warnings: ["empty image file"] },
      sections: [],
      rawCharCount: 0,
    };
  }

  /* Universal Cascade: Tier 1 (system-ocr) → Tier 2 (vision-llm) при quality<0.5.
     Tier 0 (text-layer) у изображения отсутствует. */
  const extractor = createImageFileExtractor(filePath);
  const cascade = await runExtractionCascade(extractor, filePath, {
    languages: opts.ocrLanguages,
    signal: opts.signal,
    visionModelKey: opts.visionModelKey,
  });

  const text = cascade.attempt?.text.trim() ?? "";
  if (!text) {
    /* Берём первые 2 уникальных warning из попыток для observability. */
    const cascadeWarnings = Array.from(
      new Set(cascade.attempts.flatMap((a) => a.warnings)),
    ).slice(0, 2);
    return {
      metadata: {
        title: baseName,
        warnings: ["OCR returned no text", ...cascadeWarnings],
      },
      sections: [],
      rawCharCount: 0,
    };
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => cleanParagraph(p))
    .filter((p) => p.length > 0);

  /* Annotate какой engine выдал текст — полезно для трассировки в book.md. */
  const engineWarning = cascade.attempt?.engine === "vision-llm"
    ? ["text recovered via vision-LLM (system OCR unavailable or low quality)"]
    : [];

  return {
    metadata: {
      title: baseName,
      warnings: [
        ...(paragraphs.length === 0 ? ["OCR produced only whitespace"] : []),
        ...engineWarning,
      ],
    },
    sections: [
      {
        level: 1,
        title: baseName,
        paragraphs: paragraphs.length > 0 ? paragraphs : [text],
      },
    ],
    rawCharCount: text.length,
  };
}

/**
 * Image parser is registered for every image extension via PARSERS map in
 * parsers/index.ts; the `ext` field is purely informational (uses "png" as
 * canonical id since one parser handles all raster formats).
 */
export const imageParser: BookParser = { ext: "png", parse: parseImage };
