/**
 * CBZ/CBR parser-обёртка — делегирует convertCbz (multi-page PDF) → pdfParser.
 *
 * Pattern зеркалит calibre-formats.ts: один parse function → wrapper'ы для
 * каждого расширения. Один converter `convertCbz()` обрабатывает оба формата
 * (CBZ через JSZip, CBR через 7z), wrapper'у не нужно об этом знать.
 *
 * Дальше pdfParser (с pdf-inspector) распознает image-only PDF и направит в
 * OCR cascade (OS OCR Tier 1 → vision-LLM Tier 2). Для комиксов:
 *   - Японская/русская манга → OS OCR может справиться
 *   - Сложные speech bubbles → vision-LLM как fallback
 */

import * as path from "path";
import type { BookParser, ParseOptions, ParseResult } from "./types.js";
import { convertCbz } from "../converters/cbz.js";

async function parseViaCbz(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const baseName = path.basename(filePath, path.extname(filePath));
  const warnings: string[] = [];

  const conv = await convertCbz(filePath, { signal: opts.signal });
  try {
    if (conv.kind === "text-extracted") {
      warnings.push(...conv.warnings);
      return {
        metadata: { title: baseName, warnings },
        sections: [],
        rawCharCount: 0,
      };
    }

    const { pdfParser } = await import("./pdf.js");
    try {
      const result = await pdfParser.parse(conv.path, opts);
      warnings.push("Converted CBZ/CBR to multi-page PDF and parsed via pdfParser");
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
      warnings.push(`pdfParser failed on CBZ-derived PDF: ${msg.slice(0, 200)}`);
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

export const cbzParser: BookParser = { ext: "cbz", parse: parseViaCbz };
export const cbrParser: BookParser = { ext: "cbr", parse: parseViaCbz };
