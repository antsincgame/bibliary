/**
 * Converters dispatcher — единая точка `convertToParseable(srcPath, ext)`.
 *
 * Маршрутизирует расширение в нужный converter:
 *   - `djvu`/`djv` → `convertDjvu` (двухступенчатый, см. converters/djvu.ts)
 *   - `mobi`/`azw`/`azw3`/`pdb`/`prc`/`chm`/`lit`/`lrf`/`snb`/`tcr` → `convertViaCalibre`
 *   - `cbz`/`cbr` → `convertCbz` (multi-page PDF через pdf-lib + JSZip/7z)
 *   - multi-page TIFF → `convertMultiTiff` (через parsers/tiff.ts wrapper, не dispatcher)
 *
 * Возвращает унифицированный `ConvertResult` с `kind: "text-extracted" | "delegate"`.
 * Caller (PARSERS dispatcher в `parsers/index.ts` через wrapper-парсеры) делегирует
 * к соответствующему примитивному parser'у (epub/pdf/...).
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Converter сам решает heavy lane scheduling (calibre — да, djvu — нет).
 *   - Cleanup ВСЕГДА callable: caller вызывает в finally без проверок.
 *   - Никогда не throw на business errors (Calibre absent, ddjvu failed) —
 *     возвращает text-extracted с warnings, чтобы импорт корректно показал
 *     status="failed" с понятной причиной.
 */

import { convertDjvu, type DjvuConvertResult } from "./djvu.js";
import { convertViaCalibre, type CalibreConvertResult } from "./calibre.js";

/** Унифицированный результат конвертации. */
export type ConvertResult = DjvuConvertResult | CalibreConvertResult;

/** Список расширений которые требуют Calibre конвертации в EPUB.
 *  Iter 6В: .rb удалён — Ruby исходники доминируют в реальных библиотеках
 *  (921 файл .rb в D:\Bibliarifull, 0 Rocket eBook). */
export const CALIBRE_INPUT_EXTS: ReadonlySet<string> = new Set([
  "mobi", "azw", "azw3", "azw4",
  "pdb", "prc",
  "chm",
  "lit", "lrf", "snb", "tcr",
]);

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

  if (CALIBRE_INPUT_EXTS.has(e)) {
    return convertViaCalibre(srcPath, { signal: opts.signal });
  }

  /* Не нужна конвертация — например epub/pdf парсятся напрямую. */
  return null;
}

export type { DjvuConvertResult, CalibreConvertResult };
