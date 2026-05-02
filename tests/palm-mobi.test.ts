/**
 * Unit-тесты palm-mobi.ts — pure-JS MOBI/PalmDoc parser.
 *
 * Phase A+B Iter 9.5 (rev. 2). Покрывает:
 *   - PalmDoc LZ77 decompression (round-trip и патологические случаи)
 *   - PDB header parsing
 *   - HTML strip + entity decoding
 *   - Гибкая обработка повреждённых файлов (no-throw, warnings)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { _internal, mobiParser } from "../electron/lib/scanner/parsers/palm-mobi.js";

const { decompressPalmDoc, stripMobiHtml, parsePdbHeader, parsePalmDocHeader } = _internal;

describe("palm-mobi / PalmDoc LZ77 decompression", () => {
  it("literal bytes (0x09-0x7F) → возвращаются как есть", () => {
    const input = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const out = decompressPalmDoc(input);
    assert.equal(out.toString("ascii"), "Hello");
  });

  it("0x00 byte → literal NUL", () => {
    const input = Buffer.from([0x41, 0x00, 0x42]); // "A\0B"
    const out = decompressPalmDoc(input);
    assert.equal(out.length, 3);
    assert.equal(out[0], 0x41);
    assert.equal(out[1], 0x00);
    assert.equal(out[2], 0x42);
  });

  it("0x01-0x08 byte → следующие N bytes literal", () => {
    /* 0x03 = next 3 bytes literal. */
    const input = Buffer.from([0x03, 0xc0, 0xc1, 0xc2, 0x41]); // [3 raw bytes 0xC0..0xC2] + 'A'
    const out = decompressPalmDoc(input);
    assert.equal(out.length, 4);
    assert.equal(out[0], 0xc0);
    assert.equal(out[1], 0xc1);
    assert.equal(out[2], 0xc2);
    assert.equal(out[3], 0x41);
  });

  it("0xC0-0xFF byte → space + literal char", () => {
    /* 0xE5 = space + (0xE5 ^ 0x80) = space + 0x65 = ' e'. */
    const input = Buffer.from([0xe5]);
    const out = decompressPalmDoc(input);
    assert.equal(out.length, 2);
    assert.equal(out[0], 0x20);
    assert.equal(out[1], 0x65);
  });

  it("back-reference: повторяет ранее выданные байты", () => {
    /* Сначала literal 'abcdefgh' (8 bytes), потом back-ref:
       byte1=0x80, byte2=0x40 → word=0x8040, distance=(word>>3)&0x7FF=0x1008/8=...
       Проще: вычислим вручную distance/length для маленького кейса. */
    /* После 8 literals (a..h), хотим повторить "abc" (distance=8, length=3).
       word = (0x80 | (8 << 3) | (3 - 3))   = ?
       distance = (word >> 3) & 0x7FF = 8
       length = (word & 0x07) + 3 = 3
       → word = (8 << 3) | 0 = 0x40, BUT need top bit 0x80 set.
       → word = 0x8040.
       → byte1 = 0x80, byte2 = 0x40. */
    const input = Buffer.from([
      0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, // "abcdefgh"
      0x80, 0x40, // back-ref: distance=8, length=3 → "abc"
    ]);
    const out = decompressPalmDoc(input);
    assert.equal(out.toString("ascii"), "abcdefghabc");
  });
});

describe("palm-mobi / stripMobiHtml", () => {
  it("удаляет <p>, <h1>, <br> вставляя \\n", () => {
    const html = "<h1>Title</h1><p>Para 1</p><p>Para 2</p>";
    const text = stripMobiHtml(html);
    assert.match(text, /Title/);
    assert.match(text, /Para 1/);
    assert.match(text, /Para 2/);
  });

  it("декодирует HTML entities", () => {
    const html = "<p>Tom &amp; Jerry &lt;3 &quot;Mom&quot;</p>";
    const text = stripMobiHtml(html);
    assert.match(text, /Tom & Jerry <3 "Mom"/);
  });

  it("декодирует numeric entities", () => {
    const html = "<p>&#1054;&#1085;&#1077;&#1075;&#1080;&#1085;</p>"; // "Онегин"
    const text = stripMobiHtml(html);
    assert.match(text, /Онегин/);
  });

  it("удаляет <script> и <style> блоки", () => {
    const html = `<style>body{color:red}</style><p>Text</p><script>alert(1)</script>`;
    const text = stripMobiHtml(html);
    assert.match(text, /Text/);
    assert.doesNotMatch(text, /alert/);
    assert.doesNotMatch(text, /color:red/);
  });
});

describe("palm-mobi / PDB header parsing", () => {
  it("парсит синтетический PDB header (BOOKMOBI)", () => {
    /* Минимальный PDB: 78 байт header + N×8 record entries. */
    const buf = Buffer.alloc(78 + 16); // 2 records
    buf.write("Test Book", 0, "ascii");
    buf.write("BOOK", 60, "ascii");
    buf.write("MOBI", 64, "ascii");
    buf.writeUInt16BE(2, 76);
    buf.writeUInt32BE(78 + 16, 78); // record 0 offset (после record table)
    buf.writeUInt32BE(78 + 16 + 100, 86); // record 1 offset
    const hdr = parsePdbHeader(buf);
    assert.equal(hdr.name, "Test Book");
    assert.equal(hdr.type, "BOOK");
    assert.equal(hdr.creator, "MOBI");
    assert.equal(hdr.numRecords, 2);
    assert.equal(hdr.recordOffsets[0], 78 + 16);
  });

  it("бросает ошибку на слишком короткий buffer", () => {
    assert.throws(() => parsePdbHeader(Buffer.alloc(10)));
  });
});

describe("palm-mobi / PalmDoc header parsing", () => {
  it("парсит compression/numTextRecords/encryption", () => {
    const rec0 = Buffer.alloc(16);
    rec0.writeUInt16BE(2, 0);    // compression = PalmDoc LZ77
    rec0.writeUInt16BE(5, 8);    // numTextRecords = 5
    rec0.writeUInt16BE(4096, 10); // recordSize = 4096
    rec0.writeUInt16BE(0, 12);    // encryption = 0
    const hdr = parsePalmDocHeader(rec0);
    assert.equal(hdr.compression, 2);
    assert.equal(hdr.numTextRecords, 5);
    assert.equal(hdr.recordSize, 4096);
    assert.equal(hdr.encryption, 0);
  });
});

describe("palm-mobi / end-to-end synthetic PDB", () => {
  /* Создаём минимальный валидный PalmDoc PDB файл (TEXtREAd, compression=1)
     и гоняем через parsePalmMobi. Это самый простой контрольный тест. */
  it("парсит uncompressed PalmDoc PDB", async () => {
    const tmpFile = path.join(os.tmpdir(), `bibliary-test-${Date.now()}.pdb`);

    const text = "Hello PalmDoc World. This is a synthetic test record.";
    const textBuf = Buffer.from(text, "latin1");

    /* Build PDB:
       0..77 = PDB header
       78..78+16 = record table (2 entries × 8)
       78+16..78+16+16 = record 0 (PalmDoc header)
       78+16+16..end = record 1 (text) */
    const recTableSize = 2 * 8;
    const rec0Start = 78 + recTableSize;
    const rec0Size = 16;
    const rec1Start = rec0Start + rec0Size;

    const buf = Buffer.alloc(rec1Start + textBuf.length);
    buf.write("Synthetic PalmDoc", 0, "ascii");
    buf.write("TEXt", 60, "ascii");
    buf.write("REAd", 64, "ascii");
    buf.writeUInt16BE(2, 76); // numRecords
    buf.writeUInt32BE(rec0Start, 78);
    buf.writeUInt32BE(rec1Start, 78 + 8);
    /* Record 0: PalmDoc header. */
    buf.writeUInt16BE(1, rec0Start + 0);   // compression = none
    buf.writeUInt16BE(1, rec0Start + 8);   // numTextRecords = 1
    buf.writeUInt16BE(textBuf.length, rec0Start + 10);
    buf.writeUInt16BE(0, rec0Start + 12);  // no encryption
    /* Record 1: raw text. */
    textBuf.copy(buf, rec1Start);

    await fs.writeFile(tmpFile, buf);
    try {
      const result = await mobiParser.parse(tmpFile);
      assert.match(result.metadata.title || "", /Synthetic PalmDoc/);
      assert.ok(result.sections.length > 0, `expected sections, got ${result.sections.length}`);
      assert.match(result.sections[0]!.paragraphs.join(" "), /Hello PalmDoc World/);
    } finally {
      await fs.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("graceful handling: encrypted PalmDoc → empty content + warnings, no throw", async () => {
    const tmpFile = path.join(os.tmpdir(), `bibliary-test-enc-${Date.now()}.pdb`);
    const buf = Buffer.alloc(78 + 8 + 16);
    buf.write("Encrypted Book", 0, "ascii");
    buf.write("BOOK", 60, "ascii");
    buf.write("MOBI", 64, "ascii");
    buf.writeUInt16BE(1, 76);
    buf.writeUInt32BE(78 + 8, 78);
    buf.writeUInt16BE(2, 78 + 8 + 0);  // compression PalmDoc
    buf.writeUInt16BE(1, 78 + 8 + 8);
    buf.writeUInt16BE(4096, 78 + 8 + 10);
    buf.writeUInt16BE(2, 78 + 8 + 12); // encryption = 2 (DRM)
    await fs.writeFile(tmpFile, buf);
    try {
      const result = await mobiParser.parse(tmpFile);
      assert.equal(result.sections.length, 0);
      assert.ok(
        result.metadata.warnings.some((w) => /encrypted/i.test(w)),
        `expected encryption warning, got ${result.metadata.warnings.join("; ")}`,
      );
    } finally {
      await fs.unlink(tmpFile).catch(() => undefined);
    }
  });

  it("graceful handling: malformed file → no throw, warnings", async () => {
    const tmpFile = path.join(os.tmpdir(), `bibliary-test-bad-${Date.now()}.mobi`);
    await fs.writeFile(tmpFile, Buffer.from("This is not a PDB file at all"));
    try {
      const result = await mobiParser.parse(tmpFile);
      assert.equal(result.sections.length, 0);
      assert.ok(result.metadata.warnings.length > 0);
    } finally {
      await fs.unlink(tmpFile).catch(() => undefined);
    }
  });
});
