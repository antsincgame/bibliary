import * as path from "path";
import { createRequire } from "module";

let cachedStandardFontDataUrl: string | null = null;

export function getPdfjsStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const pkgPath = req.resolve("pdfjs-dist/package.json");
  const fontsDir = path.join(path.dirname(pkgPath), "standard_fonts");
  cachedStandardFontDataUrl = fontsDir.endsWith(path.sep) ? fontsDir : `${fontsDir}${path.sep}`;
  return cachedStandardFontDataUrl;
}
