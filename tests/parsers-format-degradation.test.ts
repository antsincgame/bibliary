/**
 * Тесты деградации парсеров: битый ZIP под .epub и невалидный XML под .fb2
 * должны возвращать warnings + sections:[] вместо throw, чтобы
 * import-book мог вернуть outcome "skipped" (не пишем в каталог), а не "failed".
 *
 * Тест для DOCX (mammoth fallthrough) и ODT (zip-fail → warnings) оставлены
 * на будущее — требуют более сложных фикстур.
 */

import * as assert from "assert/strict";
import { test } from "node:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const { parseBook } = await import("../electron/lib/scanner/parsers/index.js");

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

async function writeTmp(ext: string, buf: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-parsers-"));
  const p = path.join(dir, `test${ext}`);
  await fs.writeFile(p, buf);
  return p;
}

async function cleanup(filePath: string): Promise<void> {
  try { await fs.rm(path.dirname(filePath), { recursive: true, force: true }); } catch { /* best-effort */ }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* FB2: невалидный XML → warnings, sections: []                               */
/* ────────────────────────────────────────────────────────────────────────── */

test("fb2: invalid XML degrades to warnings instead of throw", async () => {
  /* fast-xml-parser is lenient — heavily broken XML may parse without throw
     but return no FictionBook root. Either way: parseBook must NOT throw. */
  const buf = Buffer.from("This is not XML at all <<< !!!>>>> broken", "utf8");
  const p = await writeTmp(".fb2", buf);
  try {
    /* Key assertion: parseBook resolves (no throw) */
    const result = await parseBook(p);
    assert.equal(result.sections.length, 0, "sections should be empty for corrupt FB2");
    assert.ok(
      result.metadata.warnings && result.metadata.warnings.length > 0,
      "should have at least one warning",
    );
    /* Warning may say 'fb2: XML parse failed' (hard parse error) OR
       'FictionBook root not found' (parser tolerates it but finds no root). */
    assert.ok(
      result.metadata.warnings!.some(
        (w) => w.toLowerCase().includes("fb2") || w.toLowerCase().includes("fictionbook"),
      ),
      `expected a warning about fb2/FictionBook, got: ${JSON.stringify(result.metadata.warnings)}`,
    );
  } finally {
    await cleanup(p);
  }
});

test("fb2: FictionBook root missing → warnings, sections: []", async () => {
  const buf = Buffer.from('<?xml version="1.0"?><root><nothing/></root>', "utf8");
  const p = await writeTmp(".fb2", buf);
  try {
    const result = await parseBook(p);
    assert.equal(result.sections.length, 0);
    assert.ok(
      result.metadata.warnings?.some((w) => w.toLowerCase().includes("fictionbook")),
      `expected FictionBook warning, got: ${JSON.stringify(result.metadata.warnings)}`,
    );
  } finally {
    await cleanup(p);
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/* EPUB: битый ZIP → warnings, sections: []                                   */
/* ────────────────────────────────────────────────────────────────────────── */

test("epub: corrupt ZIP degrades to warnings instead of throw", async () => {
  const buf = Buffer.from("PK\x03\x04 this is not a valid zip archive !!", "binary");
  const p = await writeTmp(".epub", buf);
  try {
    const result = await parseBook(p);
    assert.equal(result.sections.length, 0, "sections should be empty for corrupt EPUB");
    assert.ok(
      result.metadata.warnings && result.metadata.warnings.length > 0,
      "should have at least one warning",
    );
    assert.ok(
      result.metadata.warnings!.some((w) => w.toLowerCase().includes("epub") || w.toLowerCase().includes("zip")),
      `expected a warning mentioning 'epub' or 'zip', got: ${JSON.stringify(result.metadata.warnings)}`,
    );
  } finally {
    await cleanup(p);
  }
});
