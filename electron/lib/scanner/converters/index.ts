/**
 * Converters dispatcher — единая точка `convertToParseable(srcPath, ext)`.
 *
 * Phase A+B Iter 9.6 (rev. 2 colibri-roadmap.md): Calibre cascade удалён
 * полностью. Текущий dispatcher маршрутизирует только:
 *   - `djvu`/`djv` → `convertDjvu` (двухступенчатый, см. converters/djvu.ts)
 *
 * CBZ/CBR парсятся через `parsers/cbz.ts` напрямую (без convert-стадии);
 * `convertCbz` остаётся как отдельный API для multi-page PDF, но не идёт
 * через этот dispatcher.
 *
 * MOBI/AZW/AZW3/PRC/PDB/CHM теперь парсятся **напрямую** через
 * `parsers/palm-mobi.ts` и `parsers/chm.ts` без converter-cascade.
 * Это упрощает архитектуру — две стадии (convert→delegate) превратились
 * в одну стадию (parse).
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Converter сам решает heavy lane scheduling (djvu — да).
 *   - Cleanup ВСЕГДА callable: caller вызывает в finally без проверок.
 *   - Никогда не throw на business errors — возвращает text-extracted с warnings.
 */

import { convertDjvu, type DjvuConvertResult } from "./djvu.js";

/** Унифицированный результат конвертации. */
export type ConvertResult = DjvuConvertResult;

export interface ConvertToParseableOptions {
  signal?: AbortSignal;
  /** Уже посчитанный djvutxt результат — для DjVu конвертера. */
  djvuPrecomputedText?: string;
}

/**
 * Распознать расширение файла и направить в правильный converter.
 *
 * Возвращает null если расширение не требует конвертации (caller должен
 * парсить файл напрямую через PARSERS[ext]).
 */
export async function convertToParseable(
  srcPath: string,
  ext: string,
  opts: ConvertToParseableOptions = {},
): Promise<ConvertResult | null> {
  const e = ext.toLowerCase();

  if (e === "djvu" || e === "djv") {
    return convertDjvu(srcPath, {
      signal: opts.signal,
      precomputedText: opts.djvuPrecomputedText,
    });
  }

  /* Не нужна конвертация — например epub/pdf парсятся напрямую. */
  return null;
}

export type { DjvuConvertResult };
