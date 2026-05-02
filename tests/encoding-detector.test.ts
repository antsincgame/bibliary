/**
 * Unit-тесты encoding-detector.ts — Phase A+B Iter 9.2.
 *
 * Проверяет распознавание кодировок русских торрент-дампов: windows-1251,
 * KOI8-R, IBM866 (DOS), а также XML/HTML in-content declarations.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as iconv from "iconv-lite";
import {
  decodeBuffer,
  detectBom,
  isEncodingSupported,
} from "../electron/lib/scanner/encoding-detector.js";

const RU_TEXT = "Война и мир — Лев Толстой";

describe("encoding-detector / detectBom", () => {
  it("распознаёт UTF-8 BOM", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(RU_TEXT, "utf8")]);
    assert.equal(detectBom(buf), "utf-8");
  });

  it("распознаёт UTF-16 LE BOM", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(RU_TEXT, "utf-16le")]);
    assert.equal(detectBom(buf), "utf-16le");
  });

  it("распознаёт UTF-16 BE BOM", () => {
    const buf = Buffer.from([0xfe, 0xff, 0x00, 0x42]);
    assert.equal(detectBom(buf), "utf-16be");
  });

  it("возвращает null для buffer без BOM", () => {
    const buf = Buffer.from(RU_TEXT, "utf8");
    assert.equal(detectBom(buf), null);
  });
});

describe("encoding-detector / decodeBuffer (BOM-cases)", () => {
  it("декодирует UTF-8 с BOM, срезая BOM", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(RU_TEXT, "utf8")]);
    const result = decodeBuffer(buf);
    assert.equal(result.encoding, "utf-8");
    assert.equal(result.source, "bom");
    assert.equal(result.text, RU_TEXT);
  });

  it("декодирует UTF-16 LE с BOM", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(RU_TEXT, "utf-16le")]);
    const result = decodeBuffer(buf);
    assert.equal(result.encoding, "utf-16le");
    assert.equal(result.source, "bom");
    assert.equal(result.text, RU_TEXT);
  });
});

describe("encoding-detector / decodeBuffer (Russian encodings без BOM)", () => {
  it("распознаёт windows-1251 (Cyrillic) через chardet", () => {
    /* Минимум 100 символов нужен для уверенной chardet detection.  */
    const longRu = (RU_TEXT + " ").repeat(20).trim();
    const buf = iconv.encode(longRu, "windows-1251");
    const result = decodeBuffer(buf);
    /* chardet может вернуть точную "windows-1251" или родственный "ISO-8859-5".
       Важно: текст должен распознаваться как кириллица, а не кракозябры. */
    assert.match(result.text, /Война|война/i, `unexpected text: ${result.text.slice(0, 50)}`);
    assert.notEqual(result.encoding, "utf-8");
    assert.equal(result.source, "chardet");
  });

  it("распознаёт KOI8-R через chardet", () => {
    const longRu = (RU_TEXT + " ").repeat(20).trim();
    const buf = iconv.encode(longRu, "koi8-r");
    const result = decodeBuffer(buf);
    assert.match(result.text, /Война|война|мир/i, `unexpected text: ${result.text.slice(0, 50)}`);
    assert.notEqual(result.encoding, "utf-8");
  });
});

describe("encoding-detector / XML declaration parsing", () => {
  it("извлекает encoding=\"windows-1251\" из XML declaration", () => {
    const xml = `<?xml version="1.0" encoding="windows-1251"?>\n<root>${RU_TEXT}</root>`;
    const buf = iconv.encode(xml, "windows-1251");
    const result = decodeBuffer(buf, { parseXmlDeclaration: true });
    assert.equal(result.encoding, "windows-1251");
    assert.equal(result.source, "xml");
    assert.match(result.text, new RegExp(RU_TEXT));
  });

  it("игнорирует XML declaration если parseXmlDeclaration=false", () => {
    const xml = `<?xml version="1.0" encoding="windows-1251"?>\n<root>X</root>`;
    const buf = iconv.encode(xml, "windows-1251");
    const result = decodeBuffer(buf, { parseXmlDeclaration: false });
    assert.notEqual(result.source, "xml");
  });

  it("UTF-8 BOM имеет приоритет над XML declaration", () => {
    /* Хитрый файл: BOM utf-8 + декларация говорит windows-1251.
       BOM авторитетнее (ISO/IEC 10646:2003 Annex H). */
    const xml = `<?xml version="1.0" encoding="windows-1251"?>\n<root>X</root>`;
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, "utf8")]);
    const result = decodeBuffer(buf, { parseXmlDeclaration: true });
    assert.equal(result.source, "bom");
    assert.equal(result.encoding, "utf-8");
  });
});

describe("encoding-detector / HTML meta charset", () => {
  it("извлекает HTML5 <meta charset=\"windows-1251\">", () => {
    const html = `<html><head><meta charset="windows-1251"></head><body>${RU_TEXT}</body></html>`;
    const buf = iconv.encode(html, "windows-1251");
    const result = decodeBuffer(buf, { parseHtmlMeta: true });
    assert.equal(result.encoding, "windows-1251");
    assert.equal(result.source, "html");
    assert.match(result.text, new RegExp(RU_TEXT));
  });

  it("извлекает HTML4 <meta http-equiv=Content-Type charset=...>", () => {
    const html =
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"></head>` +
      `<body>${RU_TEXT}</body></html>`;
    const buf = iconv.encode(html, "windows-1251");
    const result = decodeBuffer(buf, { parseHtmlMeta: true });
    assert.equal(result.encoding, "windows-1251");
    assert.equal(result.source, "html");
  });
});

describe("encoding-detector / нормализация имён кодировок", () => {
  it("принимает алиасы Cyrillic кодировок", () => {
    assert.ok(isEncodingSupported("cp1251"));
    assert.ok(isEncodingSupported("windows-1251"));
    assert.ok(isEncodingSupported("WINDOWS-1251"));
    assert.ok(isEncodingSupported("koi8-r"));
    assert.ok(isEncodingSupported("KOI8R"));
    assert.ok(isEncodingSupported("cp866"));
    assert.ok(isEncodingSupported("ibm866"));
  });
});

describe("encoding-detector / fallback и graceful degradation", () => {
  it("использует hint encoding если BOM/declaration/chardet не сработали", () => {
    const buf = Buffer.from([0xc1, 0xc2, 0xc3]);
    const result = decodeBuffer(buf, { fallbackEncoding: "windows-1251" });
    assert.ok(result.text.length > 0);
  });

  it("возвращает UTF-8 default для пустого buffer", () => {
    const result = decodeBuffer(Buffer.from([]));
    assert.equal(result.text, "");
    assert.equal(result.source, "default");
  });
});
