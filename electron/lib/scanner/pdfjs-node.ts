import * as path from "path";
import { createRequire } from "module";

let cachedStandardFontDataUrl: string | null = null;
let cachedCMapUrl: string | null = null;

/**
 * Returns the path to pdfjs-dist standard_fonts/ directory.
 *
 * Uses createRequire() anchored at this file in compiled Electron (CommonJS) and
 * at project package.json under tsx/ESM tests. That keeps Electron ASAR resolution
 * working while avoiding `__filename is not defined` in ESM diagnostics.
 *
 * createRequire(__filename) is the idiomatic Electron ASAR path; the fallback is
 * only for source-mode scripts/tests where package.json lives at process.cwd().
 */
export function getPdfjsStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;

  const anchor = typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json");
  const req = createRequire(anchor);
  const pkgPath = req.resolve("pdfjs-dist/package.json");
  const fontsDir = path.join(path.dirname(pkgPath), "standard_fonts");
  cachedStandardFontDataUrl = fontsDir.endsWith(path.sep) ? fontsDir : `${fontsDir}${path.sep}`;
  return cachedStandardFontDataUrl;
}

/**
 * Returns the path to pdfjs-dist cmaps/ directory as a file:// URL string.
 *
 * CMap files are required for correct text extraction from PDFs that use
 * custom/non-standard font encodings (common in scanned books, old Russian
 * PDFs, and publications with embedded CJK or Cyrillic fonts).
 *
 * Without CMap support, pdfjs-dist falls back to glyph-ID-based text
 * extraction which produces garbled characters (e.g. Cyrillic words rendered
 * as sequences of Latin/symbol glyphs).
 */
export function getPdfjsCMapUrl(): string {
  if (cachedCMapUrl) return cachedCMapUrl;

  const anchor = typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json");
  const req = createRequire(anchor);
  const pkgPath = req.resolve("pdfjs-dist/package.json");
  const cmapsDir = path.join(path.dirname(pkgPath), "cmaps");
  const withSep = cmapsDir.endsWith(path.sep) ? cmapsDir : `${cmapsDir}${path.sep}`;
  cachedCMapUrl = withSep;
  return cachedCMapUrl;
}
