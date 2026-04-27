import * as path from "path";
import { createRequire } from "module";

let cachedStandardFontDataUrl: string | null = null;

/**
 * Returns the path to pdfjs-dist standard_fonts/ directory.
 *
 * Uses __dirname (anchored to this compiled file in dist-electron/lib/scanner/)
 * instead of process.cwd() which is unreliable in Electron portable / asar builds
 * where cwd may point to a temp directory that has no node_modules.
 *
 * Layout inside asar:
 *   dist-electron/lib/scanner/pdfjs-node.js  ← __dirname
 *   dist-electron/lib/scanner/               ← __dirname
 *   dist-electron/lib/                       ← ../
 *   dist-electron/                           ← ../../
 *   <app-root>/                              ← ../../../  (has package.json + node_modules)
 */
export function getPdfjsStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;

  /* Walk up from compiled file location to the app root. */
  const appRoot = path.resolve(__dirname, "..", "..", "..");
  const anchorPkg = path.join(appRoot, "package.json");

  const req = createRequire(anchorPkg);
  const pkgPath = req.resolve("pdfjs-dist/package.json");
  const fontsDir = path.join(path.dirname(pkgPath), "standard_fonts");
  cachedStandardFontDataUrl = fontsDir.endsWith(path.sep) ? fontsDir : `${fontsDir}${path.sep}`;
  return cachedStandardFontDataUrl;
}
