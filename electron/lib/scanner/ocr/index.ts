/**
 * Phase 6.0 -- OS-native OCR service.
 *
 * Wraps `@napi-rs/system-ocr` (Windows.Media.Ocr on Windows, Vision Framework
 * on macOS) and `@napi-rs/canvas` for PDF page rasterisation. No bundled
 * binaries, no Tesseract, no Python — only OS-provided engines.
 *
 * On Linux: gracefully unsupported (no system OCR API). UI must check
 * `isOcrSupported()` before exposing the toggle.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

export type OcrAccuracy = "fast" | "accurate";

export interface OcrLineBox {
  text: string;
  /** Normalised bbox in 0..1 (x, y, w, h). Empty if engine doesn't expose it. */
  bbox?: [number, number, number, number];
  confidence?: number;
}

export interface OcrPageResult {
  pageIndex: number;
  text: string;
  lines: OcrLineBox[];
  language?: string;
}

export interface OcrSupportInfo {
  supported: boolean;
  platform: NodeJS.Platform;
  reason?: string;
}

export function getOcrSupport(): OcrSupportInfo {
  const platform = os.platform();
  if (platform === "win32" || platform === "darwin") {
    return { supported: true, platform };
  }
  return {
    supported: false,
    platform,
    reason: "OS-native OCR is available only on Windows (Windows.Media.Ocr) and macOS (Vision Framework)",
  };
}

export function isOcrSupported(): boolean {
  return getOcrSupport().supported;
}

interface SystemOcrModule {
  recognize: (
    input: string | Buffer | Uint8Array,
    accuracy?: number,
    languages?: string[]
  ) => Promise<{
    text: string;
    lines?: Array<{ text: string; confidence?: number; bbox?: [number, number, number, number] }>;
    language?: string;
  } | string>;
  OcrAccuracy?: { Fast: number; Accurate: number };
}

let cachedModule: SystemOcrModule | null = null;
let cachedModuleError: Error | null = null;

async function loadSystemOcr(): Promise<SystemOcrModule> {
  if (cachedModule) return cachedModule;
  if (cachedModuleError) throw cachedModuleError;
  if (!isOcrSupported()) {
    cachedModuleError = new Error("OCR not supported on this OS");
    throw cachedModuleError;
  }
  try {
    const mod = (await import("@napi-rs/system-ocr")) as unknown as SystemOcrModule;
    cachedModule = mod;
    return mod;
  } catch (err) {
    cachedModuleError = err instanceof Error ? err : new Error(String(err));
    throw cachedModuleError;
  }
}

function accuracyToNumeric(mod: SystemOcrModule, accuracy: OcrAccuracy): number | undefined {
  if (!mod.OcrAccuracy) return undefined;
  return accuracy === "accurate" ? mod.OcrAccuracy.Accurate : mod.OcrAccuracy.Fast;
}

function normaliseResult(
  raw: Awaited<ReturnType<SystemOcrModule["recognize"]>>,
  pageIndex: number
): OcrPageResult {
  if (typeof raw === "string") {
    return { pageIndex, text: raw, lines: [] };
  }
  const lines: OcrLineBox[] = Array.isArray(raw.lines)
    ? raw.lines.map((l) => ({ text: l.text, confidence: l.confidence, bbox: l.bbox }))
    : [];
  return {
    pageIndex,
    text: raw.text || lines.map((l) => l.text).join("\n"),
    lines,
    language: raw.language,
  };
}

/**
 * Recognise a single image file. Supports PNG, JPG, JPEG, BMP, TIFF, WEBP
 * (anything the OS engine accepts).
 */
export async function recognizeImageFile(
  filePath: string,
  languages: string[] = [],
  accuracy: OcrAccuracy = "accurate"
): Promise<OcrPageResult> {
  const mod = await loadSystemOcr();
  const acc = accuracyToNumeric(mod, accuracy);
  const buf = await fs.readFile(filePath);
  const raw = await mod.recognize(buf, acc, languages);
  return normaliseResult(raw, 0);
}

/**
 * Recognise an in-memory image buffer (e.g. rasterised PDF page).
 */
export async function recognizeImageBuffer(
  buffer: Buffer,
  pageIndex: number,
  languages: string[] = [],
  accuracy: OcrAccuracy = "accurate"
): Promise<OcrPageResult> {
  const mod = await loadSystemOcr();
  const acc = accuracyToNumeric(mod, accuracy);
  const raw = await mod.recognize(buffer, acc, languages);
  return normaliseResult(raw, pageIndex);
}

/**
 * Render a PDF to PNG buffers (one per page) using @napi-rs/canvas.
 * Heavy: rasterises at given DPI. Caller must pass `signal` for cancel
 * support. Yields a buffer per page so the consumer can OCR streaming.
 */
export async function* rasterisePdfPages(
  pdfPath: string,
  opts: {
    dpi?: number;
    signal?: AbortSignal;
    pageRange?: { from: number; to: number };
  } = {}
): AsyncGenerator<{ pageIndex: number; pngBuffer: Buffer; widthPx: number; heightPx: number }, void, void> {
  const dpi = opts.dpi ?? 200;
  const scale = dpi / 72;

  const { createCanvas } = await import("@napi-rs/canvas");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const buf = await fs.readFile(pdfPath);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const doc = await loadingTask.promise;

  try {
    const fromPage = Math.max(1, opts.pageRange?.from ?? 1);
    const toPage = Math.min(doc.numPages, opts.pageRange?.to ?? doc.numPages);

    for (let pageNum = fromPage; pageNum <= toPage; pageNum++) {
      if (opts.signal?.aborted) throw new Error(String(opts.signal.reason || "aborted"));
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const widthPx = Math.ceil(viewport.width);
      const heightPx = Math.ceil(viewport.height);
      const canvas = createCanvas(widthPx, heightPx);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, widthPx, heightPx);
      await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      const pngBuffer = canvas.toBuffer("image/png");
      page.cleanup();
      yield { pageIndex: pageNum - 1, pngBuffer, widthPx, heightPx };
    }
  } finally {
    await doc.destroy();
  }
}

/**
 * Save a rasterised page to a temp file (some OCR engines work best with paths).
 * Returned path is in OS temp dir — caller is responsible for cleanup or letting
 * the OS GC it.
 */
export async function pageBufferToTempPng(buffer: Buffer, pageIndex: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-ocr-"));
  const file = path.join(dir, `page-${String(pageIndex + 1).padStart(4, "0")}.png`);
  await fs.writeFile(file, buffer);
  return file;
}

export async function safeUnlink(file: string): Promise<void> {
  try { await fs.unlink(file); } catch { /* already gone */ }
  try { await fs.rmdir(path.dirname(file)); } catch { /* dir not empty or gone */ }
}
