import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parseBook } from "../server/lib/scanner/parsers/index.js";

test("DJVU parser respects ocrEnabled=false and does not auto-OCR raster pages", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "scan.djvu");
  await writeFile(file, Buffer.from("not a real djvu, but enough to exercise failed text extraction"));

  const started = Date.now();
  const parsed = await parseBook(file, { ocrEnabled: false, djvuOcrProvider: "system" });
  const elapsedMs = Date.now() - started;

  assert.equal(parsed.sections.length, 0);
  assert.ok(
    parsed.metadata.warnings.some((w) => w.includes("OCR is disabled")),
    `expected OCR-disabled warning, got: ${parsed.metadata.warnings.join(" | ")}`,
  );
  assert.ok(
    !parsed.metadata.warnings.some((w) => /OCR applied|OCR failed on page|OCR produced no text/i.test(w)),
    `OCR path should not run when disabled, got: ${parsed.metadata.warnings.join(" | ")}`,
  );
  assert.ok(elapsedMs < 5_000, `disabled OCR path should return quickly, took ${elapsedMs}ms`);
});
