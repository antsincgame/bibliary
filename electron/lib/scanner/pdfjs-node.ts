import * as path from "path";
import { createRequire } from "module";

let cachedStandardFontDataUrl: string | null = null;

/**
 * Returns the path to pdfjs-dist standard_fonts/ directory.
 *
 * Uses createRequire(__filename) so that Electron's ASAR transparent FS intercepts
 * the module resolution from the correct context (this file's location inside the
 * ASAR), rather than from process.cwd() (extraction temp root, no node_modules)
 * or a manually-computed anchor that depends on directory depth assumptions.
 *
 * createRequire(__filename) is the idiomatic way to resolve modules from inside
 * an Electron ASAR build — the ASAR patch wraps Module._resolveFilename which
 * createRequire uses internally.
 */
export function getPdfjsStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;

  /* Anchor at this file — Electron ASAR FS intercepts resolve() calls. */
  const req = createRequire(__filename);
  const pkgPath = req.resolve("pdfjs-dist/package.json");
  const fontsDir = path.join(path.dirname(pkgPath), "standard_fonts");
  cachedStandardFontDataUrl = fontsDir.endsWith(path.sep) ? fontsDir : `${fontsDir}${path.sep}`;
  return cachedStandardFontDataUrl;
}
