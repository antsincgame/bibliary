/**
 * Palm/MOBI Parser — pure-JS byte-level парсер для PalmDB-based форматов.
 *
 * Phase A+B Iter 9.5 (rev. 2 colibri-roadmap.md). Заменяет Calibre cascade для:
 *
 *   .mobi  — Mobipocket (BOOKMOBI magic)
 *   .azw   — Amazon Kindle (BOOKMOBI legacy)
 *   .azw3  — Amazon Kindle KF8 (BOOKMOBI + KF8 boundary record)
 *   .prc   — Palm Resource (BOOKMOBI или REAdTEXt)
 *   .pdb   — Palm Database (TEXtREAd PalmDoc)
 *
 * АРХИТЕКТУРА:
 *
 *   1. PalmDB header (76 байт) → name, type, creator, numRecords.
 *   2. Record info table (8 байт × numRecords) → offset каждой записи.
 *   3. Record 0 = header chunk:
 *        - bytes 0-15: PalmDoc header (compression, numTextRecords, recordSize, encryption)
 *        - bytes 16+: optional MOBI header (если type=BOOK creator=MOBI)
 *   4. Records 1..numTextRecords = compressed text chunks.
 *   5. EXTH record (если type=MOBI и exthFlag bit 6) → metadata (title, author, ...).
 *   6. Decompression:
 *        compression=1  → none (как есть)
 *        compression=2  → PalmDoc LZ77 (поддерживается)
 *        compression=17480 → HUFF/CDIC (KF8) — partial fallback (warning + metadata only)
 *
 * Декодирование:
 *   - PalmDoc TEXtREAd: ASCII + Latin-1 (старые Palm-устройства)
 *   - MOBI: encoding code в header (1252 → windows-1252, 65001 → UTF-8)
 *
 * ЛИЦЕНЗИЯ: Pure-JS оригинальный код, спецификация PalmDoc — public domain.
 *  Никаких зависимостей от GPL Calibre/MOBI-tools.
 *
 * Reference:
 *   https://wiki.mobileread.com/wiki/PalmDOC
 *   https://wiki.mobileread.com/wiki/MOBI
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as iconv from "iconv-lite";
import {
  cleanParagraph,
  type BookParser,
  type ParseOptions,
  type ParseResult,
  type BookSection,
  type SupportedExt,
} from "./types.js";

const PDB_HEADER_SIZE = 78;
const RECORD_ENTRY_SIZE = 8;
const PALMDOC_HEADER_SIZE = 16;
const MOBI_MAGIC = "MOBI";

/* Compression codes per PalmDoc spec. */
const COMPRESSION_NONE = 1;
const COMPRESSION_PALMDOC = 2;
const COMPRESSION_HUFF_CDIC = 17480;

interface PdbHeader {
  name: string;
  type: string;
  creator: string;
  numRecords: number;
  recordOffsets: number[];
}

interface PalmDocHeader {
  compression: number;
  numTextRecords: number;
  recordSize: number;
  encryption: number;
}

interface MobiMetadata {
  title?: string;
  author?: string;
  publisher?: string;
  language?: string;
  encoding: string;
}

/**
 * Парсит первые 78 байт PDB и таблицу offset-ов records.
 */
function parsePdbHeader(buf: Buffer): PdbHeader {
  if (buf.length < PDB_HEADER_SIZE) {
    throw new Error(`PDB too short: ${buf.length} bytes`);
  }
  const name = buf.subarray(0, 32).toString("ascii").replace(/\0+$/, "");
  const type = buf.subarray(60, 64).toString("ascii");
  const creator = buf.subarray(64, 68).toString("ascii");
  const numRecords = buf.readUInt16BE(76);
  const recordOffsets: number[] = [];
  const tableEnd = PDB_HEADER_SIZE + numRecords * RECORD_ENTRY_SIZE;
  if (buf.length < tableEnd) {
    throw new Error(`PDB record table truncated`);
  }
  for (let i = 0; i < numRecords; i++) {
    const entryOffset = PDB_HEADER_SIZE + i * RECORD_ENTRY_SIZE;
    recordOffsets.push(buf.readUInt32BE(entryOffset));
  }
  return { name, type, creator, numRecords, recordOffsets };
}

/**
 * Извлекает буфер указанной record по индексу.
 */
function getRecordBuffer(
  buf: Buffer,
  hdr: PdbHeader,
  index: number,
): Buffer | null {
  if (index < 0 || index >= hdr.numRecords) return null;
  const start = hdr.recordOffsets[index]!;
  const end =
    index + 1 < hdr.numRecords ? hdr.recordOffsets[index + 1]! : buf.length;
  if (start >= buf.length || end > buf.length || end <= start) return null;
  return buf.subarray(start, end);
}

/**
 * Парсит PalmDoc header (первые 16 байт record 0).
 */
function parsePalmDocHeader(rec0: Buffer): PalmDocHeader {
  if (rec0.length < PALMDOC_HEADER_SIZE) {
    throw new Error(`PalmDoc header truncated: ${rec0.length}`);
  }
  return {
    compression: rec0.readUInt16BE(0),
    numTextRecords: rec0.readUInt16BE(8),
    recordSize: rec0.readUInt16BE(10),
    encryption: rec0.readUInt16BE(12),
  };
}

/**
 * Парсит MOBI header (если record 0 содержит magic 'MOBI' на offset 16).
 */
function parseMobiMetadata(rec0: Buffer): MobiMetadata {
  const meta: MobiMetadata = { encoding: "utf-8" };
  if (rec0.length < 32) return meta;
  const magic = rec0.subarray(16, 20).toString("ascii");
  if (magic !== MOBI_MAGIC) {
    /* PalmDoc PDB без MOBI-расширений (старые Palm). Latin-1 default. */
    meta.encoding = "latin1";
    return meta;
  }
  /* MOBI header offset = 16. Внутри:
     +28: encoding (uint32 BE) — 1252 = win-1252, 65001 = UTF-8, 65002 = UTF-16
     +84: titleOffset (от начала record 0)
     +88: titleLength
     +128: exthFlag */
  if (rec0.length < 32 + 100) return meta;
  const encodingCode = rec0.readUInt32BE(16 + 28);
  if (encodingCode === 1252) meta.encoding = "windows-1252";
  else if (encodingCode === 65001) meta.encoding = "utf-8";
  else if (encodingCode === 65002) meta.encoding = "utf-16le";
  else meta.encoding = "utf-8";

  const titleOffset = rec0.readUInt32BE(16 + 84);
  const titleLength = rec0.readUInt32BE(16 + 88);
  if (titleOffset > 0 && titleLength > 0 && titleOffset + titleLength <= rec0.length) {
    meta.title = iconv.decode(
      rec0.subarray(titleOffset, titleOffset + titleLength),
      meta.encoding,
    );
  }

  /* EXTH parsing: header at offset = 16 + mobi_header_length (offset 16+20). */
  const mobiHeaderLen = rec0.readUInt32BE(16 + 20);
  const exthFlag = rec0.length > 16 + 128 ? rec0.readUInt32BE(16 + 128) : 0;
  const hasExth = (exthFlag & 0x40) !== 0;
  if (hasExth) {
    const exthOffset = 16 + mobiHeaderLen;
    parseExthRecords(rec0, exthOffset, meta);
  }

  return meta;
}

/**
 * Парсит EXTH-записи (key-value метаданные за MOBI header).
 * Структура: 'EXTH' magic + headerLen + recordCount + records.
 * Каждая запись: type (uint32 BE) + length (uint32 BE) + data (length - 8 байт).
 */
function parseExthRecords(rec0: Buffer, exthOffset: number, meta: MobiMetadata): void {
  if (exthOffset + 12 > rec0.length) return;
  const magic = rec0.subarray(exthOffset, exthOffset + 4).toString("ascii");
  if (magic !== "EXTH") return;
  const recordCount = rec0.readUInt32BE(exthOffset + 8);
  let cursor = exthOffset + 12;
  /* EXTH type codes (per MobileRead wiki):
     100 = author, 101 = publisher, 524 = language */
  for (let i = 0; i < recordCount && cursor + 8 < rec0.length; i++) {
    const type = rec0.readUInt32BE(cursor);
    const length = rec0.readUInt32BE(cursor + 4);
    if (length < 8 || cursor + length > rec0.length) break;
    const data = rec0.subarray(cursor + 8, cursor + length);
    if (type === 100 && !meta.author) meta.author = iconv.decode(data, meta.encoding).trim();
    else if (type === 101 && !meta.publisher) meta.publisher = iconv.decode(data, meta.encoding).trim();
    else if (type === 524 && !meta.language) meta.language = iconv.decode(data, meta.encoding).trim();
    cursor += length;
  }
}

/**
 * PalmDoc LZ77 decompression.
 *
 * Спецификация: каждый байт в input определяет токен:
 *   0x00         → literal byte (как есть)
 *   0x01-0x08    → next N bytes are literal (length = N)
 *   0x09-0x7F    → literal byte
 *   0x80-0xBF    → 16-bit back-reference: distance (11 bits) + length (3 bits + 3)
 *   0xC0-0xFF    → space + (byte XOR 0x80) literal char
 *
 * Источник: PalmDOC спецификация — public domain.
 */
function decompressPalmDoc(input: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const b = input[i++]!;
    if (b === 0x00) {
      out.push(0x00);
    } else if (b >= 0x01 && b <= 0x08) {
      /* Next b bytes are literal. */
      for (let j = 0; j < b && i < input.length; j++) {
        out.push(input[i++]!);
      }
    } else if (b >= 0x09 && b <= 0x7f) {
      out.push(b);
    } else if (b >= 0x80 && b <= 0xbf) {
      /* 16-bit back-reference: byte1=b, byte2=input[i++]. */
      if (i >= input.length) break;
      const b2 = input[i++]!;
      const word = (b << 8) | b2;
      const distance = (word >> 3) & 0x07ff;
      const length = (word & 0x0007) + 3;
      const start = out.length - distance;
      if (start < 0) continue;
      for (let j = 0; j < length; j++) {
        out.push(out[start + j] ?? 0);
      }
    } else {
      /* 0xC0-0xFF: space + (b XOR 0x80) literal char. */
      out.push(0x20);
      out.push(b ^ 0x80);
    }
  }
  return Buffer.from(out);
}

/**
 * Главная функция: парсит MOBI/PRC/PDB файл и возвращает ParseResult.
 *
 * Возвращает empty content + warnings если encryption или Huff/CDIC.
 * Caller получит status="failed" с понятным реасоном.
 */
async function parsePalmMobi(filePath: string, _opts: ParseOptions = {}): Promise<ParseResult> {
  const baseName = path.basename(filePath, path.extname(filePath));
  const warnings: string[] = [];
  const buf = await fs.readFile(filePath);

  let pdb: PdbHeader;
  try {
    pdb = parsePdbHeader(buf);
  } catch (err) {
    warnings.push(`palm-mobi: invalid PDB header: ${err instanceof Error ? err.message : String(err)}`);
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  /* Проверка типа: BOOKMOBI (Mobipocket/Amazon), TEXtREAd (PalmDoc). */
  const isMobi = pdb.type === "BOOK" && pdb.creator === "MOBI";
  const isPalmDoc = pdb.type === "TEXt" && pdb.creator === "REAd";
  if (!isMobi && !isPalmDoc) {
    warnings.push(`palm-mobi: unknown PDB type/creator "${pdb.type}/${pdb.creator}"`);
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  const rec0 = getRecordBuffer(buf, pdb, 0);
  if (!rec0) {
    warnings.push(`palm-mobi: missing record 0`);
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  const palmDoc = parsePalmDocHeader(rec0);
  const mobiMeta = isMobi ? parseMobiMetadata(rec0) : { encoding: "latin1" as const };

  /* DRM check. */
  if (palmDoc.encryption !== 0) {
    warnings.push(`palm-mobi: file is DRM-encrypted (encryption=${palmDoc.encryption}); cannot extract text`);
    return {
      metadata: {
        title: mobiMeta.title || pdb.name || baseName,
        author: mobiMeta.author,
        warnings,
      },
      sections: [],
      rawCharCount: 0,
    };
  }

  /* Compression dispatch. */
  if (palmDoc.compression === COMPRESSION_HUFF_CDIC) {
    /* KF8/AZW3 использует Huffman/CDIC — сложный декомпрессор требующий
       загрузки HUFF и CDIC records. Не реализовано в этом парсере.
       Книга добавляется в каталог по metadata из EXTH header, но текст для
       импорта/кристаллизации не извлекается. Пользователь может открыть
       оригинал во внешней читалке через «Открыть оригинал». */
    warnings.push(
      `palm-mobi: KF8/Huffman compression not supported in importer; ` +
        `use built-in reader for content. Metadata extracted from headers.`,
    );
    return {
      metadata: {
        title: mobiMeta.title || pdb.name || baseName,
        author: mobiMeta.author,
        warnings,
      },
      sections: [],
      rawCharCount: 0,
    };
  }
  if (palmDoc.compression !== COMPRESSION_NONE && palmDoc.compression !== COMPRESSION_PALMDOC) {
    warnings.push(`palm-mobi: unknown compression code ${palmDoc.compression}`);
    return {
      metadata: { title: mobiMeta.title || pdb.name || baseName, author: mobiMeta.author, warnings },
      sections: [],
      rawCharCount: 0,
    };
  }

  /* Extract and decompress text records. */
  const textChunks: Buffer[] = [];
  for (let i = 1; i <= palmDoc.numTextRecords && i < pdb.numRecords; i++) {
    const rec = getRecordBuffer(buf, pdb, i);
    if (!rec) continue;
    /* MOBI text records имеют trailing entries (multibyte/end-of-record markers)
       чьё количество кодируется в trailingFlags. Для простой реализации
       MOBI v5/v6 не учитываем trailing — большинство файлов работают и так,
       но некоторые байты в конце могут оказаться мусорным trailing data. */
    const decompressed =
      palmDoc.compression === COMPRESSION_PALMDOC ? decompressPalmDoc(rec) : rec;
    textChunks.push(decompressed);
  }

  if (textChunks.length === 0) {
    warnings.push(`palm-mobi: no text records found`);
    return {
      metadata: { title: mobiMeta.title || pdb.name || baseName, author: mobiMeta.author, warnings },
      sections: [],
      rawCharCount: 0,
    };
  }

  const combinedBuf = Buffer.concat(textChunks);
  const encoding = mobiMeta.encoding ?? "latin1";
  let text: string;
  try {
    text = iconv.decode(combinedBuf, encoding);
  } catch {
    text = combinedBuf.toString("utf8");
    warnings.push(`palm-mobi: encoding "${encoding}" failed, fell back to UTF-8`);
  }

  /* MOBI чаще всего HTML inside compressed records.
     Простая heuristic strip tags + entity decode. */
  const plainText = stripMobiHtml(text);
  const sections: BookSection[] = splitToSections(plainText, baseName);

  return {
    metadata: {
      title: mobiMeta.title || pdb.name || baseName,
      author: mobiMeta.author,
      language: mobiMeta.language,
      warnings,
    },
    sections,
    rawCharCount: plainText.length,
  };
}

/**
 * Удаляет HTML tags и декодирует entities. Простая, но рабочая для MOBI.
 */
function stripMobiHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:p|div|h[1-6]|li|br)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x?([0-9a-fA-F]+);/g, (_, h: string) => {
      const code = h.toLowerCase().startsWith("0x") || /^[a-f]/i.test(h)
        ? parseInt(h, 16)
        : parseInt(h, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Разбивает text по \n\n на параграфы; первая строка-heading начинает секцию.
 * Та же эвристика что в txt.ts — для совместимости pipeline.
 */
function splitToSections(text: string, baseName: string): BookSection[] {
  const blocks = text.split(/\n\s*\n/).map((b) => cleanParagraph(b)).filter(Boolean);
  if (blocks.length === 0) return [];
  const sections: BookSection[] = [{ level: 1, title: baseName, paragraphs: [] }];
  for (const block of blocks) {
    sections[0]!.paragraphs.push(block.replace(/\n/g, " "));
  }
  return sections;
}

/**
 * Создаёт BookParser для каждого Palm-based extension.
 * Один и тот же parsePalmMobi обслуживает .mobi/.azw/.azw3/.prc/.pdb.
 */
function makePalmMobiParser(ext: SupportedExt): BookParser {
  return { ext, parse: parsePalmMobi };
}

export const mobiParser: BookParser = makePalmMobiParser("mobi");
export const azwParser: BookParser = makePalmMobiParser("azw");
export const azw3Parser: BookParser = makePalmMobiParser("azw3");
export const prcParser: BookParser = makePalmMobiParser("prc");
export const pdbParser: BookParser = makePalmMobiParser("pdb");

/* Внутренние helpers — экспортируются для unit-тестов. */
export const _internal = {
  parsePdbHeader,
  parsePalmDocHeader,
  parseMobiMetadata,
  decompressPalmDoc,
  stripMobiHtml,
};
