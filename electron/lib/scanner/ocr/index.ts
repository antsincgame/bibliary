/**
 * Phase 6.0 -- OS-native OCR service.
 *
 * Wraps `@napi-rs/system-ocr` (Windows.Media.Ocr on Windows, Vision Framework
 * on macOS) and `@napi-rs/canvas` for PDF page rasterisation. No bundled
 * binaries, no Tesseract, no Python -- only OS-provided engines.
 *
 * On Linux: gracefully unsupported (no system OCR API). UI must check
 * `isOcrSupported()` before exposing the toggle.
 *
 * Real upstream API (verified against node_modules/@napi-rs/system-ocr/index.d.ts):
 *   recognize(image, accuracy?, preferredLangs?, signal?): Promise<{ text, confidence }>
 *   - Windows engine ignores `accuracy` and uses only the FIRST language.
 *   - confidence is always 1.0 on Windows.
 *   - There are no bbox / line breakdowns from the engine.
 */

import { promises as fs } from "fs";
import * as os from "os";
import { getPdfjsStandardFontDataUrl, getPdfjsCMapUrl } from "../pdfjs-node.js";

export type OcrAccuracy = "fast" | "accurate";

/**
 * Reorders an OCR language list so that a Cyrillic language comes first.
 *
 * Critical for Windows: `@napi-rs/system-ocr` (Windows.Media.Ocr) uses ONLY
 * the FIRST language in the array. If the list starts with "en" (default pref),
 * the engine uses English mode and produces Latin letters for Cyrillic glyphs.
 *
 * Rules:
 *   1. If the list already starts with "ru" or "uk" → return as-is (no change).
 *   2. Otherwise move "ru" to front (preferred for Russian), or "uk" if "ru" absent.
 *   3. If neither is present → return as-is (caller knows best).
 *
 * This is called unconditionally when OCR confusion is detected in a DjVu text
 * layer, so the re-OCR attempt uses the correct primary language.
 */
export function reorderLanguagesForCyrillic(languages: string[]): string[] {
  if (languages.length === 0) return ["ru", "uk", "en"];
  if (languages[0] === "ru" || languages[0] === "uk") return languages;

  const ruIndex = languages.indexOf("ru");
  if (ruIndex > 0) {
    return ["ru", ...languages.slice(0, ruIndex), ...languages.slice(ruIndex + 1)];
  }

  const ukIndex = languages.indexOf("uk");
  if (ukIndex > 0) {
    return ["uk", ...languages.slice(0, ukIndex), ...languages.slice(ukIndex + 1)];
  }

  return languages;
}

export interface OcrPageResult {
  pageIndex: number;
  text: string;
  /** 0..1; Windows engine returns 1.0 for any successful recognition. */
  confidence: number;
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
    input: string | Uint8Array,
    accuracy?: number | null,
    preferredLangs?: string[] | null,
    signal?: AbortSignal | null,
  ) => Promise<{ text: string; confidence: number }>;
  OcrAccuracy: { Fast: 0; Accurate: 1 };
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

function accuracyToNumeric(mod: SystemOcrModule, accuracy: OcrAccuracy): number {
  return accuracy === "accurate" ? mod.OcrAccuracy.Accurate : mod.OcrAccuracy.Fast;
}

/**
 * Recognise a single image file. Supports PNG, JPG, JPEG, BMP, TIFF, WEBP
 * (anything the OS engine accepts).
 */
export async function recognizeImageFile(
  filePath: string,
  languages: string[] = [],
  accuracy: OcrAccuracy = "accurate",
  signal?: AbortSignal,
): Promise<OcrPageResult> {
  const mod = await loadSystemOcr();
  const acc = accuracyToNumeric(mod, accuracy);
  const langs = languages.length > 0 ? languages : null;
  const result = await mod.recognize(filePath, acc, langs, signal ?? null);
  return { pageIndex: 0, text: result.text, confidence: result.confidence };
}

/**
 * Recognise an in-memory image buffer (e.g. rasterised PDF page).
 */
export async function recognizeImageBuffer(
  buffer: Uint8Array,
  pageIndex: number,
  languages: string[] = [],
  accuracy: OcrAccuracy = "accurate",
  signal?: AbortSignal,
): Promise<OcrPageResult> {
  const mod = await loadSystemOcr();
  const acc = accuracyToNumeric(mod, accuracy);
  const langs = languages.length > 0 ? languages : null;
  const result = await mod.recognize(buffer, acc, langs, signal ?? null);
  return { pageIndex, text: result.text, confidence: result.confidence };
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
  } = {},
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
    standardFontDataUrl: getPdfjsStandardFontDataUrl(),
    cMapUrl: getPdfjsCMapUrl(),
    cMapPacked: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
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
