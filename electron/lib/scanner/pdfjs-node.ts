import * as path from "path";
import { createRequire } from "module";

let cachedStandardFontDataUrl: string | null = null;

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
