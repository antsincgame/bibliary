/**
 * Image extractors per format.
 *
 * Каждый extractor возвращает массив `ImageRef` с сырыми байтами и mime-типом.
 * Кодирование в Base64 делается ВЫШЕ (md-converter.ts), чтобы можно было
 * считать общий объём заранее и обрезать перед раздуванием Markdown.
 *
 * Все extractors -- чистые CPU-задачи. Безопасно вызывать параллельно с
 * GPU-кристаллизацией (LM Studio).
 */

import { promises as fs } from "fs";
import * as path from "path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { ImageRef } from "./types.js";
import { getDjvuPageCount, runDdjvu } from "../scanner/parsers/djvu-cli.js";
import { getPdfjsStandardFontDataUrl } from "../scanner/pdfjs-node.js";
import { imageBufferToPng } from "../native/sharp-loader.js";

const DEFAULT_MAX_IMAGES = 100;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RASTER_PAGE_LIMIT = 12;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function mimeFromHref(href: string, fallback?: string): string | null {
  const ext = path.extname(href).toLowerCase().slice(1);
  if (ext && IMAGE_MIME_BY_EXT[ext]) return IMAGE_MIME_BY_EXT[ext];
  if (fallback && fallback.startsWith("image/")) return fallback;
  return null;
}

interface ExtractContext {
  maxImages: number;
  maxImageBytes: number;
  warnings: string[];
}

function makeCtx(opts?: { maxImageBytes?: number; maxImagesPerBook?: number }, warnings?: string[]): ExtractContext {
  return {
    maxImages: opts?.maxImagesPerBook ?? DEFAULT_MAX_IMAGES,
    maxImageBytes: opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    warnings: warnings ?? [],
  };
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function rasterPageLimit(maxImagesPerBook: number | undefined): number {
  const env = Number.parseInt(process.env.BIBLIARY_RASTER_IMAGE_PAGE_LIMIT ?? "", 10);
  const fallback = Number.isInteger(env) && env > 0 ? env : DEFAULT_RASTER_PAGE_LIMIT;
  return Math.max(1, Math.min(maxImagesPerBook ?? fallback, fallback));
}

/* ─────────────────────────── EPUB ─────────────────────────── */

/**
 * Извлекает картинки из EPUB: открывает ZIP, ищет manifest items с
 * media-type image/*, читает байты. Первая найденная обложка
 * (`properties="cover-image"` для EPUB3 или `<meta name="cover">` для EPUB2)
 * получает id `img-cover`.
 */
export async function extractEpubImages(
  filePath: string,
  opts?: { maxImageBytes?: number; maxImagesPerBook?: number },
): Promise<{ images: ImageRef[]; warnings: string[] }> {
  const ctx = makeCtx(opts);
  try {
    const buf = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(buf);
    const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false });

    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) return { images: [], warnings: ["epub: no container.xml"] };
    const container = xmlParser.parse(await containerFile.async("string")) as Record<string, unknown>;
    const rootfileNode = (((container["container"] as Record<string, unknown>)?.["rootfiles"] as Record<string, unknown>)?.["rootfile"]) as Record<string, unknown> | Record<string, unknown>[] | undefined;
    const rootfileObj = (Array.isArray(rootfileNode) ? rootfileNode[0] : rootfileNode) as Record<string, unknown> | undefined;
    const opfPath = rootfileObj?.["@_full-path"] as string | undefined;
    if (!opfPath) return { images: [], warnings: ["epub: no rootfile path"] };

    const opfFile = zip.file(opfPath);
    if (!opfFile) return { images: [], warnings: [`epub: missing OPF at ${opfPath}`] };
    const opf = xmlParser.parse(await opfFile.async("string")) as Record<string, unknown>;
    const pkg = opf["package"] as Record<string, unknown> | undefined;
    const manifestRaw = (pkg?.["manifest"] as Record<string, unknown> | undefined)?.["item"];
    const items = (Array.isArray(manifestRaw) ? manifestRaw : manifestRaw ? [manifestRaw] : []) as Array<Record<string, unknown>>;

    const md = pkg?.["metadata"] as Record<string, unknown> | undefined;
    const metaArr = (Array.isArray(md?.["meta"]) ? md?.["meta"] : md?.["meta"] ? [md["meta"]] : []) as Array<Record<string, unknown>>;
    const cover2Id = (() => {
      for (const m of metaArr) {
        if (String(m["@_name"] ?? "") === "cover") return String(m["@_content"] ?? "");
      }
      return null;
    })();

    const opfDir = path.posix.dirname(opfPath);
    const resolveHref = (href: string): string => (!opfDir || opfDir === "." ? href : `${opfDir}/${href}`.replace(/\\/g, "/"));

    const images: ImageRef[] = [];
    let coverFound = false;
    let imgCounter = 0;

    for (const it of items) {
      if (images.length >= ctx.maxImages) {
        ctx.warnings.push(`epub: image cap reached (${ctx.maxImages})`);
        break;
      }
      const mediaType = String(it["@_media-type"] ?? "");
      if (!mediaType.startsWith("image/")) continue;
      const id = String(it["@_id"] ?? "");
      const href = String(it["@_href"] ?? "");
      const properties = String(it["@_properties"] ?? "");
      const isCover = !coverFound && (properties.includes("cover-image") || (cover2Id !== null && id === cover2Id));

      const file = zip.file(resolveHref(href));
      if (!file) continue;
      const data = await file.async("nodebuffer");
      if (data.length > ctx.maxImageBytes) {
        ctx.warnings.push(`epub: image ${href} oversized (${data.length} bytes), skipped`);
        continue;
      }

      let imgId: string;
      if (isCover) {
        imgId = "img-cover";
        coverFound = true;
      } else {
        imgCounter += 1;
        imgId = `img-${pad3(imgCounter)}`;
      }
      images.push({ id: imgId, mimeType: mediaType, buffer: data });
    }

    /* Если обложку не нашли явно (или manifest указывал на отсутствующий
       файл) -- первая извлечённая картинка становится обложкой. */
    const hasCoverAssigned = images.some((img) => img.id === "img-cover");
    if (!hasCoverAssigned && images.length > 0) {
      images[0].id = "img-cover";
    }

    return { images, warnings: ctx.warnings };
  } catch (e) {
    return { images: [], warnings: [`epub: extract failed -- ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/* ─────────────────────────── DOCX ─────────────────────────── */

/**
 * DOCX = ZIP. Картинки лежат в `word/media/`.
 */
export async function extractDocxImages(
  filePath: string,
  opts?: { maxImageBytes?: number; maxImagesPerBook?: number },
): Promise<{ images: ImageRef[]; warnings: string[] }> {
  const ctx = makeCtx(opts);
  try {
    const buf = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(buf);
    const images: ImageRef[] = [];
    let imgCounter = 0;

    const mediaFiles = zip.folder("word/media");
    if (!mediaFiles) return { images: [], warnings: ["docx: no word/media folder"] };

    const entries: Array<{ name: string; file: JSZip.JSZipObject }> = [];
    mediaFiles.forEach((relPath, file) => {
      if (!file.dir) entries.push({ name: relPath, file });
    });
    /* Сортируем по имени для детерминированного порядка между запусками. */
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const { name, file } of entries) {
      if (images.length >= ctx.maxImages) {
        ctx.warnings.push(`docx: image cap reached (${ctx.maxImages})`);
        break;
      }
      const mime = mimeFromHref(name);
      if (!mime) continue;
      const data = await file.async("nodebuffer");
      if (data.length > ctx.maxImageBytes) {
        ctx.warnings.push(`docx: image ${name} oversized (${data.length} bytes), skipped`);
        continue;
      }
      imgCounter += 1;
      const imgId = imgCounter === 1 ? "img-cover" : `img-${pad3(imgCounter - 1)}`;
      images.push({ id: imgId, mimeType: mime, buffer: data });
    }

    return { images, warnings: ctx.warnings };
  } catch (e) {
    return { images: [], warnings: [`docx: extract failed -- ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/* ─────────────────────────── FB2 ─────────────────────────── */

/**
 * FB2 = XML с встроенными `<binary>` блоками (Base64).
 * Декодируем обратно в Buffer для единообразия с другими экстракторами;
 * в md-converter Buffer снова кодируется в Base64 -- это OK, FB2 редко
 * содержит >5-10 картинок.
 */
export async function extractFb2Images(
  filePath: string,
  opts?: { maxImageBytes?: number; maxImagesPerBook?: number },
): Promise<{ images: ImageRef[]; warnings: string[] }> {
  const ctx = makeCtx(opts);
  try {
    const xmlText = await fs.readFile(filePath, "utf8");
    const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false });
    const parsed = xmlParser.parse(xmlText) as Record<string, unknown>;
    const root = (parsed["FictionBook"] ?? parsed["fictionBook"]) as Record<string, unknown> | undefined;
    if (!root) return { images: [], warnings: ["fb2: no FictionBook root"] };

    const binariesRaw = root["binary"];
    const binaries = (Array.isArray(binariesRaw) ? binariesRaw : binariesRaw ? [binariesRaw] : []) as Array<Record<string, unknown>>;
    const images: ImageRef[] = [];
    let imgCounter = 0;

    /* Cover в FB2: в <description><title-info><coverpage><image l:href="#binary_id"/>. */
    const coverHref = (() => {
      const d = root["description"] as Record<string, unknown> | undefined;
      const ti = d?.["title-info"] as Record<string, unknown> | undefined;
      const cp = ti?.["coverpage"] as Record<string, unknown> | undefined;
      const img = cp?.["image"] as Record<string, unknown> | undefined;
      const href = (img?.["@_l:href"] ?? img?.["@_href"]) as string | undefined;
      return href ? href.replace(/^#/, "") : null;
    })();

    for (const bin of binaries) {
      if (images.length >= ctx.maxImages) {
        ctx.warnings.push(`fb2: image cap reached (${ctx.maxImages})`);
        break;
      }
      const id = String(bin["@_id"] ?? "");
      const contentType = String(bin["@_content-type"] ?? "");
      const b64 = String(bin["#text"] ?? "").replace(/\s+/g, "");
      if (!id || !contentType.startsWith("image/") || !b64) continue;
      const data = Buffer.from(b64, "base64");
      if (data.length > ctx.maxImageBytes) {
        ctx.warnings.push(`fb2: image ${id} oversized (${data.length} bytes), skipped`);
        continue;
      }
      const isCover = coverHref !== null && id === coverHref;
      let imgId: string;
      if (isCover) {
        imgId = "img-cover";
      } else {
        imgCounter += 1;
        imgId = `img-${pad3(imgCounter)}`;
      }
      images.push({ id: imgId, mimeType: contentType, buffer: data });
    }

    /* Fallback: если coverHref не указан ИЛИ указанный binary не найден,
       первая извлечённая картинка становится обложкой. Это закрывает
       реальные FB2 файлы, где `<coverpage>` ссылается на отсутствующий id. */
    const hasCoverAssigned = images.some((img) => img.id === "img-cover");
    if (!hasCoverAssigned && images.length > 0) {
      images[0].id = "img-cover";
    }

    return { images, warnings: ctx.warnings };
  } catch (e) {
    return { images: [], warnings: [`fb2: extract failed -- ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/* ─────────────────────────── PDF (page gallery) ─────────────────────────── */

/**
 * Универсальное извлечение визуального слоя PDF: рендерим первые N страниц
 * как PNG. Это не пытается достать raw XObject, зато гарантированно сохраняет
 * обложку, схемы, таблицы и сканы как иллюстрации в `book.md`.
 */
export async function extractPdfImages(
  filePath: string,
  opts?: { maxImageBytes?: number; maxImagesPerBook?: number; targetWidth?: number; signal?: AbortSignal },
): Promise<{ images: ImageRef[]; warnings: string[] }> {
  const warnings: string[] = [];
  const maxBytes = opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const targetWidth = opts?.targetWidth ?? 600;
  const pageLimit = rasterPageLimit(opts?.maxImagesPerBook);

  let doc: Awaited<ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs").getDocument>["promise"]> | null = null;
  try {
    if (opts?.signal?.aborted) return { images: [], warnings: ["pdf-images: aborted"] };
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const buf = await fs.readFile(filePath);
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const loadingTask = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: getPdfjsStandardFontDataUrl(),
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    try {
      doc = await loadingTask.promise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { images: [], warnings: [`pdf-images: getDocument failed -- ${msg.slice(0, 120)}`] };
    }

    if (doc.numPages === 0) {
      return { images: [], warnings: ["pdf-images: 0 pages"] };
    }

    const { createCanvas } = await import("@napi-rs/canvas");
    const images: ImageRef[] = [];
    const pagesToRender = Math.min(doc.numPages, pageLimit);

    for (let pageIndex = 0; pageIndex < pagesToRender; pageIndex++) {
      if (opts?.signal?.aborted) {
        warnings.push("pdf-images: aborted");
        break;
      }
      const page = await doc.getPage(pageIndex + 1);
      const initialViewport = page.getViewport({ scale: 1 });
      const scale = targetWidth / initialViewport.width;
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx2d = canvas.getContext("2d");

      /* pdfjs ожидает Web-canvas-совместимый контекст. @napi-rs/canvas почти
         полностью совместим, но pdfjs требует свойство `canvas` на контексте. */
      (ctx2d as unknown as { canvas: unknown }).canvas = canvas;

      await page.render({
        canvasContext: ctx2d as unknown as CanvasRenderingContext2D,
        viewport,
      } as Parameters<typeof page.render>[0]).promise;

      const png = canvas.toBuffer("image/png");
      await page.cleanup();

      if (png.length > maxBytes) {
        warnings.push(`pdf-images: page ${pageIndex + 1} rendered ${png.length} bytes > ${maxBytes} cap, skipped`);
        continue;
      }
      images.push({
        id: pageIndex === 0 ? "img-cover" : `img-${pad3(pageIndex)}`,
        mimeType: "image/png",
        buffer: png,
        caption: pageIndex === 0 ? "Page 1 (cover)" : `Page ${pageIndex + 1}`,
      });
    }

    if (doc.numPages > pagesToRender) warnings.push(`pdf-images: page gallery limited to ${pagesToRender}/${doc.numPages} pages`);
    return { images, warnings };
  } catch (e) {
    return { images: [], warnings: [`pdf-images: render failed -- ${e instanceof Error ? e.message : String(e)}`] };
  } finally {
    await doc?.destroy().catch((err) => console.error("[image-extractors/pdfImages] destroy Error:", err));
  }
}

/* ─────────────────────────── DJVU (page gallery) ─────────────────────────── */

export async function extractDjvuImages(
  filePath: string,
  opts?: { maxImageBytes?: number; maxImagesPerBook?: number; targetWidth?: number; signal?: AbortSignal; dpi?: number },
): Promise<{ images: ImageRef[]; warnings: string[] }> {
  const warnings: string[] = [];
  const maxBytes = opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const targetWidth = opts?.targetWidth ?? 600;
  const dpi = Math.max(72, opts?.dpi ?? 200);

  try {
    if (opts?.signal?.aborted) return { images: [], warnings: ["djvu-images: aborted"] };
    let pageCount = 1;
    try {
      pageCount = await getDjvuPageCount(filePath, opts?.signal);
    } catch (e) {
      warnings.push(`djvu-images: page count failed -- ${e instanceof Error ? e.message : String(e)}`);
    }
    const pagesToRender = Math.min(pageCount, rasterPageLimit(opts?.maxImagesPerBook));
    const images: ImageRef[] = [];

    for (let pageIndex = 0; pageIndex < pagesToRender; pageIndex++) {
      if (opts?.signal?.aborted) {
        warnings.push("djvu-images: aborted");
        break;
      }
      try {
        const tiff = await runDdjvu(filePath, pageIndex, dpi, opts?.signal);
        if (tiff.length === 0) {
          warnings.push(`djvu-images: page ${pageIndex + 1} empty render`);
          continue;
        }
        const png = await imageBufferToPng(tiff, targetWidth);
        if (png.length > maxBytes) {
          warnings.push(`djvu-images: page ${pageIndex + 1} rendered ${png.length} bytes > ${maxBytes} cap, skipped`);
          continue;
        }
        images.push({
          id: pageIndex === 0 ? "img-cover" : `img-${pad3(pageIndex)}`,
          mimeType: "image/png",
          buffer: png,
          caption: pageIndex === 0 ? "Page 1 (cover)" : `Page ${pageIndex + 1}`,
        });
      } catch (e) {
        warnings.push(`djvu-images: page ${pageIndex + 1} render failed -- ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (pageCount > pagesToRender) warnings.push(`djvu-images: page gallery limited to ${pagesToRender}/${pageCount} pages`);
    return { images, warnings };
  } catch (e) {
    return { images: [], warnings: [`djvu-images: render failed -- ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/* ─────────────────────────── Dispatcher ─────────────────────────── */

/**
 * Главный entry-point: выбирает extractor по расширению.
 * TXT возвращает пустой массив (нет картинок).
 */
export async function extractBookImages(
  filePath: string,
  format: import("./types.js").SupportedBookFormat,
  opts?: { maxImageBytes?: number; maxImagesPerBook?: number; signal?: AbortSignal },
): Promise<{ images: ImageRef[]; warnings: string[] }> {
  switch (format) {
    case "epub":
      return extractEpubImages(filePath, opts);
    case "docx":
      return extractDocxImages(filePath, opts);
    case "doc":
      return { images: [], warnings: [] };
    case "fb2":
      return extractFb2Images(filePath, opts);
    case "pdf":
      return extractPdfImages(filePath, { maxImageBytes: opts?.maxImageBytes, maxImagesPerBook: opts?.maxImagesPerBook, signal: opts?.signal });
    case "djvu":
      return extractDjvuImages(filePath, { maxImageBytes: opts?.maxImageBytes, maxImagesPerBook: opts?.maxImagesPerBook, signal: opts?.signal });
    case "txt":
    case "rtf":
    case "odt":
    case "html":
    case "htm":
      return { images: [], warnings: [] };
    default:
      return { images: [], warnings: [`unknown format: ${format}`] };
  }
}
