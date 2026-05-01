/**
 * Calibre Formats parser-обёртка — MOBI/AZW/AZW3/PDB/PRC/CHM.
 *
 * Один парсер обслуживает все 6 расширений (как `djvu`/`djv` обслуживаются
 * одним `djvuParser`). Логика общая:
 *   1. `convertViaCalibre` → EPUB через scheduler heavy lane.
 *   2. Делегация в `epubParser.parse(epubPath, opts)`.
 *   3. Cleanup временного EPUB в finally.
 *
 * При отсутствии Calibre — graceful: возвращает пустой ParseResult с warnings
 * (caller увидит status="failed" с понятным install-hint).
 */

import * as path from "path";
import type { BookParser, ParseOptions, ParseResult, SupportedExt } from "./types.js";
import { convertViaCalibre } from "../converters/calibre.js";

async function parseViaCalibre(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const baseName = path.basename(filePath, path.extname(filePath));
  const warnings: string[] = [];

  const conv = await convertViaCalibre(filePath, { signal: opts.signal });
  try {
    if (conv.kind === "text-extracted") {
      /* Calibre absent или ebook-convert упал — пустой результат + warnings. */
      warnings.push(...conv.warnings);
      return {
        metadata: { title: baseName, warnings },
        sections: [],
        rawCharCount: 0,
      };
    }

    /* Lazy import чтобы избежать circular dependency calibre-formats↔index↔epub. */
    const { epubParser } = await import("./epub.js");
    try {
      const result = await epubParser.parse(conv.path, opts);
      warnings.push(`Converted to EPUB via Calibre and parsed via epubParser`);
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
      warnings.push(`epubParser failed on Calibre output: ${msg.slice(0, 200)}`);
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

/**
 * Создаёт BookParser для указанного расширения, делегируя работу в Calibre.
 * Объявление как factory — потому что `BookParser.ext` строго один literal,
 * а нам нужно 6 разных registrations для одного и того же кода.
 */
function makeCalibreParser(ext: SupportedExt): BookParser {
  return { ext, parse: parseViaCalibre };
}

export const mobiParser: BookParser = makeCalibreParser("mobi");
export const azwParser: BookParser = makeCalibreParser("azw");
export const azw3Parser: BookParser = makeCalibreParser("azw3");
export const pdbParser: BookParser = makeCalibreParser("pdb");
export const prcParser: BookParser = makeCalibreParser("prc");
export const chmParser: BookParser = makeCalibreParser("chm");

/* Iter 6Б — расширение коллекции legacy форматов через тот же Calibre wrapper.
   TCR (Psion 90-е), LIT (MS Reader, deprecated 2012), LRF (Sony BBeB, deprecated 2010),
   SNB (Samsung Note Book ~200x). Все нишевые, но в архивных коллекциях встречаются.
   .rb удалён в Iter 6В — расширение слишком общее, в реальных библиотеках
   преимущественно Ruby исходники (921 файл в D:\Bibliarifull против 0 Rocket eBook). */
export const tcrParser: BookParser = makeCalibreParser("tcr");
export const litParser: BookParser = makeCalibreParser("lit");
export const lrfParser: BookParser = makeCalibreParser("lrf");
export const snbParser: BookParser = makeCalibreParser("snb");
