/**
 * CBZ/CBR Converter — комиксы и манга в multi-page PDF.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   CBZ = ZIP-архив с jpg/png страницами (001.jpg, 002.jpg, ...).
 *   CBR = RAR-архив с теми же страницами (CDisplay convention).
 *
 *   Pipeline:
 *     1. Распаковка архива (JSZip для CBZ, vendor/7zip для CBR через ZIP path).
 *     2. Фильтрация images по расширению + natural sort (001 < 002 < ... < 010).
 *     3. Embed каждое изображение в pdf-lib document как отдельная page.
 *     4. Save → tmpdir/converted.pdf, delegate к pdfParser.
 *
 *   Дальше pdfParser (с pdf-inspector) распознает что это Scanned-PDF и
 *   запустит OS OCR cascade (см. Universal Light-First Cascade в Контуре 4).
 *
 *   Bibliary НЕ ридер — мы индексируем библиотеку, выдёргиваем текст для
 *   embedding/LLM. Для комиксов текст обычно в speech bubbles и подписях →
 *   OS OCR справится для большинства, vision-LLM — fallback на сложные.
 *
 * Heavy lane scheduling — PDF generation для 500-страничного комикса = время
 * и память. Идёт через `getImportScheduler().enqueue("heavy", ...)`.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { killChildTree } from "../../resilience/kill-tree.js";
import { existsSync, chmodSync } from "fs";
import { createRequire } from "module";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { getImportScheduler } from "../../library/import-task-scheduler.js";
import { platformVendorDirsWithLegacy, platformExeName } from "../../platform.js";
import { getCachedConvert, setCachedConvert } from "./cache.js";

const req = createRequire(path.join(process.cwd(), "package.json"));

/* Re-using тип контракта converters — same shape as DjvuConvertResult / CalibreConvertResult. */
export type CbzConvertResult =
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

export interface CbzConvertOptions {
  signal?: AbortSignal;
  /** Максимум страниц на конвертацию. Default: 1000 (большие комиксы редкость). */
  maxPages?: number;
  /** Максимум суммарного размера images. Default: 500 MB. */
  maxBytes?: number;
}

const IMAGE_EXTS: ReadonlySet<string> = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp",
]);

const DEFAULT_MAX_PAGES = 1000;
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Natural sort comparator: "001.jpg" < "002.jpg" < ... < "010.jpg".
 * Без него sort-by-string даст порядок 1, 10, 11, 2, 20...
 * Кодекс CDisplay: страницы нумеруются последовательно с padding.
 */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Resolve 7z для CBR. Зеркалит pattern из archive-extractor.ts:resolve7zBinary.
 * Не дублируем код — но не reuse чтобы избежать circular dependency
 * library/archive-extractor → scanner/converters/cbz → library/...
 */
function resolve7zBinaryForCbr(): string | null {
  const env = process.env["BIBLIARY_7Z_PATH"]?.trim();
  if (env && existsSync(env)) return env;

  const exeName = platformExeName("7z");
  const candidates: string[] = [];
  for (const subdir of platformVendorDirsWithLegacy()) {
    candidates.push(path.join(process.cwd(), "vendor", "7zip", subdir));
  }
  for (const root of candidates) {
    const candidate = path.join(root, exeName);
    if (existsSync(candidate)) return candidate;
  }
  for (const pkg of ["7z-bin", "7zip-bin"]) {
    try {
      const mod = req(pkg) as { path7z?: string; path7za?: string };
      const resolved = mod.path7z ?? mod.path7za;
      if (typeof resolved === "string" && existsSync(resolved)) {
        /* npm tarballs sometimes drop the execute bit — restore it so the
           7z spawn doesn't fail with EACCES. Absolute paths only. */
        if (path.isAbsolute(resolved)) {
          try { chmodSync(resolved, 0o755); } catch { /* read-only fs */ }
        }
        return resolved;
      }
    } catch {
      /* optional helper package not present */
    }
  }
  return process.platform === "win32" ? null : "7z";
}

interface ExtractedImage {
  name: string;
  buffer: Buffer;
}

async function extractImagesFromZip(
  cbzPath: string,
  opts: Required<Pick<CbzConvertOptions, "maxPages" | "maxBytes">>,
  warnings: string[],
): Promise<ExtractedImage[]> {
  const buf = await fs.readFile(cbzPath);
  const zip = await JSZip.loadAsync(buf);

  const entries: { name: string; jszipFile: JSZip.JSZipObject }[] = [];
  zip.forEach((relPath, file) => {
    if (file.dir) return;
    const ext = path.extname(relPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return;
    entries.push({ name: relPath, jszipFile: file });
  });

  if (entries.length === 0) {
    warnings.push("CBZ contains no image files");
    return [];
  }

  entries.sort((a, b) => naturalCompare(a.name, b.name));

  const limited = entries.slice(0, opts.maxPages);
  if (entries.length > opts.maxPages) {
    warnings.push(`CBZ has ${entries.length} images, limited to ${opts.maxPages}`);
  }

  const images: ExtractedImage[] = [];
  let totalBytes = 0;

  for (const entry of limited) {
    const data = await entry.jszipFile.async("nodebuffer");
    totalBytes += data.length;
    if (totalBytes > opts.maxBytes) {
      warnings.push(`CBZ exceeded ${Math.round(opts.maxBytes / (1024 * 1024))} MB limit, stopped at ${images.length} pages`);
      break;
    }
    images.push({ name: entry.name, buffer: data });
  }

  return images;
}

async function extractImagesFromRar(
  cbrPath: string,
  opts: Required<Pick<CbzConvertOptions, "maxPages" | "maxBytes">>,
  warnings: string[],
  signal: AbortSignal | undefined,
): Promise<{ images: ExtractedImage[]; cleanup: () => Promise<void> }> {
  const sevenZ = resolve7zBinaryForCbr();
  if (!sevenZ) {
    warnings.push("CBR support requires 7z binary. Set BIBLIARY_7Z_PATH or install vendor/7zip.");
    return { images: [], cleanup: async () => undefined };
  }

  const tempDir = path.join(tmpdir(), `bibliary-cbr-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const cleanup = async (): Promise<void> => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  };

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("CBR extraction aborted"));
      return;
    }
    /* `7z x -y -o<dir> <archive>` — extract with overwrite, into outDir. */
    const child = spawn(sevenZ, ["x", "-y", `-o${tempDir}`, cbrPath], { windowsHide: true });
    let stderr = "";
    const onAbort = (): void => {
      /* Iter 14.3: tree-kill — см. `electron/lib/resilience/kill-tree.ts`. */
      killChildTree(child, { gracefulMs: 500 });
      reject(new Error("CBR extraction aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`7z exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });

  /* Пройдёмся рекурсивно по tempDir, соберём image-файлы. */
  const found: { absPath: string; relPath: string }[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const abs = path.join(dir, item.name);
      const r = path.posix.join(rel, item.name);
      if (item.isDirectory()) {
        await walk(abs, r);
      } else if (item.isFile() && IMAGE_EXTS.has(path.extname(item.name).toLowerCase())) {
        found.push({ absPath: abs, relPath: r });
      }
    }
  }
  await walk(tempDir, "");

  if (found.length === 0) {
    warnings.push("CBR contains no image files after extraction");
    return { images: [], cleanup };
  }

  found.sort((a, b) => naturalCompare(a.relPath, b.relPath));
  const limited = found.slice(0, opts.maxPages);
  if (found.length > opts.maxPages) {
    warnings.push(`CBR has ${found.length} images, limited to ${opts.maxPages}`);
  }

  const images: ExtractedImage[] = [];
  let totalBytes = 0;
  for (const item of limited) {
    const data = await fs.readFile(item.absPath);
    totalBytes += data.length;
    if (totalBytes > opts.maxBytes) {
      warnings.push(`CBR exceeded ${Math.round(opts.maxBytes / (1024 * 1024))} MB limit, stopped at ${images.length} pages`);
      break;
    }
    images.push({ name: item.relPath, buffer: data });
  }
  return { images, cleanup };
}

/**
 * Создать multi-page PDF из массива изображений через pdf-lib.
 * Каждая страница = одно изображение, фит page-size под image.
 *
 * Detect формата по magic bytes — pdf-lib требует знания JPG vs PNG (отдельные API).
 * WebP/GIF/BMP конвертируются через sharp в PNG (используем существующий imageBufferToPng).
 */
async function imagesToPdf(images: ExtractedImage[], warnings: string[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();

  for (const img of images) {
    const buf = img.buffer;
    let embedded;
    /* JPEG magic: FF D8 FF */
    const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    /* PNG magic: 89 50 4E 47 0D 0A 1A 0A */
    const isPng =
      buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;

    try {
      if (isJpeg) {
        embedded = await pdfDoc.embedJpg(buf);
      } else if (isPng) {
        embedded = await pdfDoc.embedPng(buf);
      } else {
        /* WebP/GIF/BMP — конвертируем в PNG через sharp. */
        const { imageBufferToPng } = await import("../../native/sharp-loader.js");
        const pngBuf = await imageBufferToPng(buf);
        embedded = await pdfDoc.embedPng(pngBuf);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`skipped ${img.name}: ${msg.slice(0, 120)}`);
      continue;
    }

    const page = pdfDoc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: embedded.width,
      height: embedded.height,
    });
  }

  if (pdfDoc.getPageCount() === 0) {
    throw new Error("CBZ/CBR conversion produced 0 pages (all images failed embed)");
  }

  return Buffer.from(await pdfDoc.save());
}

/**
 * Главный entry-point: CBZ или CBR файл → multi-page PDF → delegate к pdfParser.
 *
 * Heavy lane: PDF generation для 500-page comic = ~5-30 секунд + ~200 MB RAM peak.
 * Сериализация через `getImportScheduler().enqueue("heavy", ...)` защищает CPU.
 */
export async function convertCbz(srcPath: string, opts: CbzConvertOptions = {}): Promise<CbzConvertResult> {
  const warnings: string[] = [];
  const ext = path.extname(srcPath).toLowerCase();
  const extKey = ext.slice(1); /* "cbz" / "cbr" без точки */

  /* Iter 6В — Cache check ДО dergstack 7z extract / pdf-lib generation.
     500-page CBZ converted = ~30 sec + 200 MB RAM peak — кэш окупается мгновенно. */
  const cached = await getCachedConvert(srcPath, extKey, "pdf");
  if (cached) {
    return {
      kind: "delegate",
      path: cached.path,
      ext: "pdf",
      warnings: cached.warnings,
      cleanup: cached.cleanup,
    };
  }

  const limits = {
    maxPages: opts.maxPages ?? DEFAULT_MAX_PAGES,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
  };

  const pdfPath = path.join(tmpdir(), `bibliary-cbz-${randomUUID()}.pdf`);
  let extractCleanup: (() => Promise<void>) | null = null;

  const cleanup = async (): Promise<void> => {
    if (extractCleanup) {
      await extractCleanup().catch((e) => console.warn("[converters/cbz] extract cleanup:", e));
      extractCleanup = null;
    }
    await fs.unlink(pdfPath).catch((e) => {
      if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      console.warn("[converters/cbz] pdf cleanup:", e);
    });
  };

  try {
    let images: ExtractedImage[];
    if (ext === ".cbz" || ext === ".zip") {
      images = await extractImagesFromZip(srcPath, limits, warnings);
    } else if (ext === ".cbr" || ext === ".rar") {
      const r = await extractImagesFromRar(srcPath, limits, warnings, opts.signal);
      images = r.images;
      extractCleanup = r.cleanup;
    } else {
      warnings.push(`convertCbz: unexpected extension ${ext}`);
      return { kind: "text-extracted", text: "", warnings, cleanup };
    }

    if (images.length === 0) {
      return { kind: "text-extracted", text: "", warnings, cleanup };
    }

    /* PDF generation в heavy lane — одновременно крутится только N=1 task. */
    const pdfBuf = await getImportScheduler().enqueue("heavy", () => imagesToPdf(images, warnings));
    await fs.writeFile(pdfPath, pdfBuf);

    /* Iter 6В — успешный convert → cache (async fire-and-forget). */
    void setCachedConvert(srcPath, extKey, pdfPath, "pdf").catch((err) => {
      console.warn("[converters/cbz] cache write failed:", err);
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
    warnings.push(`CBZ/CBR conversion failed: ${msg.slice(0, 200)}`);
    return { kind: "text-extracted", text: "", warnings, cleanup };
  }
}
