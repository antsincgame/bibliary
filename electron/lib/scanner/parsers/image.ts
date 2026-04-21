/**
 * Image parser: turns a PNG/JPG/etc into a single-section ParseResult by
 * running OS-native OCR. Produced sections feed the same chunker as PDF/EPUB.
 *
 * Phase 6.0 -- introduced together with OCR service.
 */

import * as path from "path";
import { promises as fs } from "fs";
import { isOcrSupported, recognizeImageFile } from "../ocr/index.js";
import { cleanParagraph, type BookParser, type ParseOptions, type ParseResult } from "./types.js";

const SUPPORTED_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp"]);

export function isSupportedImage(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return SUPPORTED_IMAGE_EXTS.has(ext);
}

async function parseImage(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const baseName = path.basename(filePath, path.extname(filePath));
  if (!isOcrSupported()) {
    return {
      metadata: {
        title: baseName,
        warnings: ["Image OCR is unavailable on this OS (need Windows or macOS)."],
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

  let result;
  try {
    result = await recognizeImageFile(filePath, opts.ocrLanguages ?? [], opts.ocrAccuracy ?? "accurate");
  } catch (err) {
    return {
      metadata: {
        title: baseName,
        warnings: [`OCR failed: ${(err as Error).message.slice(0, 200)}`],
      },
      sections: [],
      rawCharCount: 0,
    };
  }

  const text = result.text.trim();
  if (!text) {
    return {
      metadata: { title: baseName, warnings: ["OCR returned no text"] },
      sections: [],
      rawCharCount: 0,
    };
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => cleanParagraph(p))
    .filter((p) => p.length > 0);

  return {
    metadata: {
      title: baseName,
      warnings: paragraphs.length === 0 ? ["OCR produced only whitespace"] : [],
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
