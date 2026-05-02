/**
 * Structural validation tests — Иt 10 smart-routing.
 *
 * Покрывают:
 *   - PDF %%EOF в хвосте файла (truncated torrent → reject)
 *   - EPUB ZIP local file header → mimetype = application/epub+zip
 *   - DJVU IFF FORM:DJVU/DJVM (helper isValidDjvuIff через verifyExtMatchesContentHead)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  verifyExtMatchesContent,
  pdfTailHasEof,
  epubStructHasMimetype,
} from "../electron/lib/library/import-magic-guard.ts";

/** Make a PDF buffer with optional %%EOF marker. */
function makePdfBuffer(opts: { withEof: boolean; size?: number }): Buffer {
  const head = Buffer.from("%PDF-1.7\n", "ascii");
  const padding = Buffer.alloc((opts.size ?? 12 * 1024) - head.length, 0x20);
  if (!opts.withEof) return Buffer.concat([head, padding]);
  /* %%EOF + newline в самом конце */
  const eof = Buffer.from("\n%%EOF\n", "ascii");
  const padTrimmed = padding.subarray(0, padding.length - eof.length);
  return Buffer.concat([head, padTrimmed, eof]);
}

/** Make a valid EPUB ZIP local file header: mimetype entry first, stored. */
function makeEpubHeader(opts: { goodMimetype: boolean }): Buffer {
  /* Local file header (30 bytes) */
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const ver = Buffer.from([0x14, 0x00]);
  const flags = Buffer.from([0x00, 0x00]);
  const compression = Buffer.from([0x00, 0x00]); // 0 = stored
  const time = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  const compSize = Buffer.from([0x14, 0x00, 0x00, 0x00]); // 20 bytes
  const uncompSize = Buffer.from([0x14, 0x00, 0x00, 0x00]);
  const nameLen = Buffer.from([0x08, 0x00]);
  const extraLen = Buffer.from([0x00, 0x00]);
  const name = Buffer.from("mimetype", "ascii");
  const payload = opts.goodMimetype
    ? Buffer.from("application/epub+zip", "ascii")
    : Buffer.from("application/zipx-bad!", "ascii");
  return Buffer.concat([sig, ver, flags, compression, time, crc, compSize, uncompSize, nameLen, extraLen, name, payload]);
}

// ─────────────────────────────────────────────────────────────────────────
// Pure function tests
// ─────────────────────────────────────────────────────────────────────────

test("pdfTailHasEof: detects %%EOF in plain tail", () => {
  const tail = Buffer.from("    \n%%EOF\n", "ascii");
  assert.equal(pdfTailHasEof(tail), true);
});

test("pdfTailHasEof: detects %%EOF without trailing newline", () => {
  const tail = Buffer.from("\n%%EOF", "ascii");
  assert.equal(pdfTailHasEof(tail), true);
});

test("pdfTailHasEof: rejects when no %%EOF anywhere", () => {
  const tail = Buffer.alloc(1024, 0x20);
  assert.equal(pdfTailHasEof(tail), false);
});

test("pdfTailHasEof: rejects partial '%%EO' at end", () => {
  const tail = Buffer.from("xxxxxx%%EO", "ascii");
  assert.equal(pdfTailHasEof(tail), false);
});

test("epubStructHasMimetype: accepts valid mimetype entry", () => {
  const v = epubStructHasMimetype(makeEpubHeader({ goodMimetype: true }));
  assert.equal(v.ok, true);
});

test("epubStructHasMimetype: rejects bad mimetype payload", () => {
  const v = epubStructHasMimetype(makeEpubHeader({ goodMimetype: false }));
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /mimetype payload is/);
});

test("epubStructHasMimetype: rejects when first entry is not 'mimetype'", () => {
  /* Имя другой длины (например 9) → first entry это не mimetype. */
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const padding = Buffer.alloc(22, 0);
  const nameLen = Buffer.from([0x09, 0x00]);
  const extraLen = Buffer.from([0x00, 0x00]);
  const name = Buffer.from("container", "ascii"); // 9 bytes
  const buf = Buffer.concat([sig, padding, nameLen, extraLen, name]);
  const v = epubStructHasMimetype(buf);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /first entry is not 'mimetype'/);
});

test("epubStructHasMimetype: rejects deflated mimetype (compression != 0)", () => {
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const ver = Buffer.from([0x14, 0x00]);
  const flags = Buffer.from([0x00, 0x00]);
  const compression = Buffer.from([0x08, 0x00]); // 8 = deflated (BAD for mimetype)
  const time = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  const sizes = Buffer.alloc(8);
  const nameLen = Buffer.from([0x08, 0x00]);
  const extraLen = Buffer.from([0x00, 0x00]);
  const name = Buffer.from("mimetype", "ascii");
  const buf = Buffer.concat([sig, ver, flags, compression, time, crc, sizes, nameLen, extraLen, name]);
  const v = epubStructHasMimetype(buf);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /must be stored/);
});

// ─────────────────────────────────────────────────────────────────────────
// Async file-level tests
// ─────────────────────────────────────────────────────────────────────────

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "magic-struct-"));
}

test("verifyExtMatchesContent: PDF without %%EOF is rejected", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "truncated.pdf");
    await writeFile(file, makePdfBuffer({ withEof: false }));
    const v = await verifyExtMatchesContent(file, "pdf");
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /no %%EOF/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExtMatchesContent: PDF with %%EOF passes", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "good.pdf");
    await writeFile(file, makePdfBuffer({ withEof: true }));
    const v = await verifyExtMatchesContent(file, "pdf");
    assert.equal(v.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExtMatchesContent: empty PDF rejected", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "empty.pdf");
    await writeFile(file, Buffer.alloc(0));
    const v = await verifyExtMatchesContent(file, "pdf");
    assert.equal(v.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExtMatchesContent: EPUB with broken mimetype rejected", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "broken.epub");
    /* Пишем ZIP header с неправильным mimetype payload */
    const buf = Buffer.concat([makeEpubHeader({ goodMimetype: false }), Buffer.alloc(1024)]);
    await writeFile(file, buf);
    const v = await verifyExtMatchesContent(file, "epub");
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /mimetype payload/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExtMatchesContent: EPUB with valid mimetype passes", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "good.epub");
    const buf = Buffer.concat([makeEpubHeader({ goodMimetype: true }), Buffer.alloc(1024)]);
    await writeFile(file, buf);
    const v = await verifyExtMatchesContent(file, "epub");
    assert.equal(v.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExtMatchesContent: DJVU truncated to AT&T-only rejected", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "trunc.djvu");
    /* Только AT&T magic, нет FORM dependency */
    const buf = Buffer.concat([
      Buffer.from([0x41, 0x54, 0x26, 0x54]),
      Buffer.alloc(1024 - 4, 0xff),
    ]);
    await writeFile(file, buf);
    const v = await verifyExtMatchesContent(file, "djvu");
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /missing FORM:DJVU/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExtMatchesContent: full DJVU IFF passes", async () => {
  const dir = await tmpDir();
  try {
    const file = path.join(dir, "good.djvu");
    const buf = Buffer.concat([
      Buffer.from([0x41, 0x54, 0x26, 0x54]),
      Buffer.from([0x46, 0x4f, 0x52, 0x4d]),
      Buffer.from([0x00, 0x00, 0x10, 0x00]),
      Buffer.from("DJVU", "ascii"),
      Buffer.alloc(1024),
    ]);
    await writeFile(file, buf);
    const v = await verifyExtMatchesContent(file, "djvu");
    assert.equal(v.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
