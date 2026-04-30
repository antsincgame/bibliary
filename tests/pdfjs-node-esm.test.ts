import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { getPdfjsStandardFontDataUrl } from "../electron/lib/scanner/pdfjs-node.ts";

test("pdfjs standard fonts resolve under tsx/ESM without __filename", () => {
  const fontsDir = getPdfjsStandardFontDataUrl();

  assert.ok(fontsDir.includes("pdfjs-dist"), fontsDir);
  assert.ok(existsSync(fontsDir), `standard_fonts dir should exist: ${fontsDir}`);
});
