/**
 * Multi-page TIFF Converter — архивные сканы → multi-page PDF.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   TIFF может быть single-page (как обычный JPG) или multi-page (как PDF).
 *   Single-page обрабатывается обычным `imageParser` (Tier 0+1+2 OCR cascade).
 *   Multi-page нужно собрать в PDF, чтобы pdfParser обработал страницы.
 *
 *   Sharp поддерживает чтение страниц через `sharp(buf, { page: N })` или
 *   `sharp(buf, { pages: -1 })` для всех. Этот converter определяет количество
 *   страниц через metadata, и если pages > 1 — собирает PDF, иначе возвращает
 *   text-extracted с empty text (caller fallbacks на imageParser напрямую).
 *
 *   CALLER КОНТРАКТ:
 *     Это converter ТОЛЬКО для multi-page TIFF. Для single-page TIFF caller
 *     должен использовать обычный imageParser напрямую (через PARSERS["tif"]).
 *     Регистрация форматов остаётся в parsers/index.ts через imageParser —
 *     этот converter вызывается ТОЛЬКО когда мы обнаружили multi-page (т.е.
 *     потенциально из image.ts wrapper'а).
 *
 *   В Iter 6Б multi-tiff converter оставлен standalone и доступен через
 *   `convertToParseable("multi-tiff")` явный путь — wiring в image-парсер
 *   (auto-detect single vs multi) — отдельная задача (Iter 6В+).
 *
 * Heavy lane scheduling — обработка 100-страничного TIFF архивного скана
 * = 200+ MB RAM peak. Через `getImportScheduler().enqueue("heavy", ...)`.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { PDFDocument } from "pdf-lib";
import { getImportScheduler } from "../../library/import-task-scheduler.js";
import { loadSharp, imageBufferToPng } from "../../native/sharp-loader.js";
import { getCachedConvert, setCachedConvert } from "./cache.js";

export type MultiTiffConvertResult =
  | {
      kind: "text-extracted";
      text: string;
      warnings: string[];
      cleanup: () => Promise<void>;
    }
  | {
      kind: "delegate";
      path: string;
      ext: "pdf";
      warnings: string[];
      cleanup: () => Promise<void>;
    };

export interface MultiTiffConvertOptions {
  signal?: AbortSignal;
  /** Максимум страниц на конвертацию. Default: 500 (архивные сканы редко больше). */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 500;

interface SharpInstance {
  metadata?: () => Promise<{ pages?: number; width?: number; height?: number }>;
  png: () => { toBuffer: () => Promise<Buffer> };
}

/**
 * Определить количество страниц в TIFF. Возвращает 1 если single-page или
 * не TIFF. Для не-TIFF файлов sharp может бросить — обрабатываем grace.
 */
export async function getTiffPageCount(filePath: string): Promise<number> {
  try {
    const sharp = await loadSharp();
    const buf = await fs.readFile(filePath);
    /* Sharp's metadata returns pages только для TIFF/GIF/WebP с page indexing.
       Для single-page форматов pages=undefined. */
    const sharpInstance = (sharp as unknown as (input: Buffer) => SharpInstance)(buf);
    if (typeof sharpInstance.metadata !== "function") return 1;
    const meta: { pages?: number; width?: number; height?: number } = await sharpInstance.metadata();
    return typeof meta.pages === "number" && meta.pages > 0 ? meta.pages : 1;
  } catch {
    return 1;
  }
}

/**
 * Распаковать страницы multi-page TIFF в PNG buffers через sharp.
 */
async function extractTiffPages(
  filePath: string,
  pageCount: number,
  warnings: string[],
): Promise<Buffer[]> {
  const sharp = await loadSharp();
  const buf = await fs.readFile(filePath);
  const pages: Buffer[] = [];

  for (let i = 0; i < pageCount; i++) {
    try {
      /* sharp(buf, { page: i }) — выбирает конкретную страницу из multi-page TIFF. */
      const sharpFactory = sharp as unknown as (input: Buffer, opts?: { page?: number; failOn?: string }) => SharpInstance;
      const png = await sharpFactory(buf, { page: i, failOn: "truncated" }).png().toBuffer();
      pages.push(png);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`TIFF page ${i + 1} extract failed: ${msg.slice(0, 120)}`);
    }
  }

  return pages;
}

async function pagesToPdf(pages: Buffer[], warnings: string[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();

  for (let i = 0; i < pages.length; i++) {
    try {
      const embedded = await pdfDoc.embedPng(pages[i]);
      const page = pdfDoc.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`embed PNG page ${i + 1} failed: ${msg.slice(0, 120)}`);
    }
  }

  if (pdfDoc.getPageCount() === 0) {
    throw new Error("multi-TIFF conversion produced 0 pages (all pages failed embed)");
  }

  return Buffer.from(await pdfDoc.save());
}

/**
 * Главный entry-point: multi-page TIFF → multi-page PDF → delegate к pdfParser.
 *
 * Если файл single-page — возвращает text-extracted с пустым text + warning
 * "use imageParser directly". Caller должен делегировать imageParser напрямую.
 */
export async function convertMultiTiff(srcPath: string, opts: MultiTiffConvertOptions = {}): Promise<MultiTiffConvertResult> {
  const warnings: string[] = [];
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const ext = path.extname(srcPath).slice(1).toLowerCase();

  /* Iter 6В — Cache check ДО sharp pages extraction. Multi-page TIFF на 100
     страниц = 200+ MB RAM peak + время. Кэш окупается мгновенно. */
  const cached = await getCachedConvert(srcPath, ext, "pdf");
  if (cached) {
    return {
      kind: "delegate",
      path: cached.path,
      ext: "pdf",
      warnings: cached.warnings,
      cleanup: cached.cleanup,
    };
  }

  const pdfPath = path.join(tmpdir(), `bibliary-tiff-${randomUUID()}.pdf`);
  const cleanup = async (): Promise<void> => {
    await fs.unlink(pdfPath).catch((e) => {
      if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      console.warn("[converters/multi-tiff] pdf cleanup:", e);
    });
  };

  if (opts.signal?.aborted) {
    warnings.push("multi-TIFF conversion aborted before start");
    return { kind: "text-extracted", text: "", warnings, cleanup };
  }

  try {
    const pageCount = await getTiffPageCount(srcPath);
    if (pageCount <= 1) {
      warnings.push(`TIFF has ${pageCount} page(s), use imageParser directly for single-page`);
      return { kind: "text-extracted", text: "", warnings, cleanup };
    }

    const limited = Math.min(pageCount, maxPages);
    if (pageCount > maxPages) {
      warnings.push(`TIFF has ${pageCount} pages, limited to ${maxPages}`);
    }

    /* Heavy lane: обработка 100-страничного TIFF + PNG conversion + PDF embed. */
    const pdfBuf = await getImportScheduler().enqueue("heavy", async () => {
      const pages = await extractTiffPages(srcPath, limited, warnings);
      if (pages.length === 0) {
        throw new Error("no pages extracted from TIFF");
      }
      return pagesToPdf(pages, warnings);
    });

    await fs.writeFile(pdfPath, pdfBuf);

    /* Iter 6В — успешный convert → cache (async fire-and-forget). */
    void setCachedConvert(srcPath, ext, pdfPath, "pdf").catch((e) => {
      console.warn("[converters/multi-tiff] cache write failed:", e);
    });

    return {
      kind: "delegate",
      path: pdfPath,
      ext: "pdf",
      warnings,
      cleanup,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`multi-TIFF conversion failed: ${msg.slice(0, 200)}`);
    return { kind: "text-extracted", text: "", warnings, cleanup };
  }
}

/* Dummy reference на imageBufferToPng чтобы не было unused-import warning
   (используется в JSDoc как часть архитектурного контракта sharp-loader). */
void imageBufferToPng;
