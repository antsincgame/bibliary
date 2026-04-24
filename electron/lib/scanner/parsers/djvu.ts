import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseOptions, type ParseResult, type BookSection } from "./types.js";
import { isOcrSupported, recognizeImageBuffer } from "../ocr/index.js";

/**
 * DJVU parser.
 *
 * DJVU is predominantly a scanned-document format. Most .djvu files are
 * raster images with an optional (and rarely present) hidden text layer
 * encoded via BZZ compression (proprietary Burrows-Wheeler variant).
 *
 * Strategy:
 *   1. Validate the IFF85 header (AT&T DJVM/DJVU magic).
 *   2. Walk FORM chunks looking for plain-text `TXTa` chunks (uncompressed)
 *      or `ANTa`/`ANTz` annotation chunks that may contain titles.
 *   3. If we find readable text → structure it into sections (like txt parser).
 *   4. If no text layer and OCR is enabled → rasterize pages via embedded
 *      page images (each DJVU page stores an IW44 wavelet-encoded image).
 *      We extract the raw image data and pass it through the OS-native OCR.
 *   5. If OCR is not available → return empty result with clear warning.
 *
 * Limitation: `TXTz` (BZZ-compressed text) chunks require a BZZ decoder
 * which is not available in pure JS. These are rare — only djvulibre-produced
 * files with `--text=words` have them. For full DJVU text extraction with BZZ,
 * users should convert to PDF first (e.g. via `ddjvu -format=pdf`).
 */

const MAX_DJVU_FILE_BYTES = 500 * 1024 * 1024;
const DJVU_MAGIC = Buffer.from("AT&TFORM");

async function parseDjvu(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const stat = await fs.stat(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const warnings: string[] = [];

  if (stat.size > MAX_DJVU_FILE_BYTES) {
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    return {
      metadata: { title: baseName, warnings: [`DJVU too large (${sizeMb} MB) — refused`] },
      sections: [],
      rawCharCount: 0,
    };
  }

  const buf = await fs.readFile(filePath);

  if (buf.length < 16 || buf.subarray(0, 4).toString("ascii") !== "AT&T") {
    return {
      metadata: { title: baseName, warnings: ["not a valid DJVU file (missing AT&T magic)"] },
      sections: [],
      rawCharCount: 0,
    };
  }

  const pageCount = countDjvuPages(buf);
  if (pageCount > 0) {
    warnings.push(`DJVU document: ${pageCount} page(s) detected`);
  }

  const plainText = extractTxtaChunks(buf);

  if (plainText.length > 0) {
    const sections = textToSections(plainText);
    const rawCharCount = plainText.length;
    return {
      metadata: { title: guessTitleFromText(plainText) || baseName, warnings },
      sections,
      rawCharCount,
    };
  }

  if (opts.ocrEnabled && isOcrSupported()) {
    return ocrDjvuPages(buf, baseName, pageCount, opts, warnings);
  }

  const reason = opts.ocrEnabled
    ? "OCR not supported on this OS (requires Windows or macOS)"
    : "OCR not enabled — turn it on in Settings to recognise scanned DJVU files";
  warnings.push(`no text layer found in DJVU (${reason})`);

  return {
    metadata: { title: baseName, warnings },
    sections: [],
    rawCharCount: 0,
  };
}

/* ── IFF85 container walking ────────────────────────────────────────────── */

function countDjvuPages(buf: Buffer): number {
  let pages = 0;
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const tag = buf.subarray(offset, offset + 4).toString("ascii");
    if (tag === "FORM" && offset + 12 <= buf.length) {
      const subTag = buf.subarray(offset + 8, offset + 12).toString("ascii");
      if (subTag === "DJVU") pages++;
      offset += 12;
    } else if (tag === "AT&T") {
      offset += 4;
    } else {
      if (offset + 8 > buf.length) break;
      const size = buf.readUInt32BE(offset + 4);
      offset += 8 + size + (size & 1);
    }
  }
  return Math.max(pages, 1);
}

/**
 * Extract uncompressed text from `TXTa` chunks. These are rare but some
 * DJVU generators produce them. Format: hierarchical text zones starting
 * with a version byte, then nested zone descriptors with UTF-8 text.
 *
 * We do a simplified extraction: scan for runs of printable UTF-8 after
 * the TXTa tag, since full zone parsing is complex and we only need
 * the readable text.
 */
function extractTxtaChunks(buf: Buffer): string {
  const parts: string[] = [];
  let offset = 0;

  while (offset + 8 <= buf.length) {
    const tag = buf.subarray(offset, offset + 4).toString("ascii");

    if (tag === "TXTa" || tag === "TXTz") {
      const chunkSize = buf.readUInt32BE(offset + 4);
      if (tag === "TXTa" && offset + 8 + chunkSize <= buf.length) {
        const payload = buf.subarray(offset + 8, offset + 8 + chunkSize);
        const text = extractReadableUtf8(payload);
        if (text.length > 10) parts.push(text);
      }
      offset += 8 + chunkSize + (chunkSize & 1);
      continue;
    }

    if (tag === "FORM" || tag === "AT&T") {
      offset += (tag === "FORM") ? 12 : 4;
      continue;
    }

    if (offset + 8 > buf.length) break;
    const size = buf.readUInt32BE(offset + 4);
    offset += 8 + size + (size & 1);
  }

  return parts.join("\n\n");
}

function extractReadableUtf8(payload: Buffer): string {
  const chars: string[] = [];
  let i = 0;
  if (payload.length > 0 && payload[0] <= 0x20) i = 1;

  while (i < payload.length) {
    const byte = payload[i];
    if (byte === 0) {
      if (chars.length > 0 && chars[chars.length - 1] !== "\n") chars.push("\n");
      i++;
      continue;
    }
    if (byte >= 0x20 && byte < 0x7f) {
      chars.push(String.fromCharCode(byte));
      i++;
    } else if (byte >= 0xc0 && byte < 0xfe && i + 1 < payload.length) {
      const len = byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      if (i + len <= payload.length) {
        try {
          const decoded = payload.subarray(i, i + len).toString("utf8");
          if (decoded.length > 0 && decoded.codePointAt(0)! >= 0x20) {
            chars.push(decoded);
          }
        } catch { /* skip malformed */ }
        i += len;
      } else {
        i++;
      }
    } else if (byte === 0x0a || byte === 0x0d) {
      chars.push("\n");
      i++;
    } else if (byte === 0x09) {
      chars.push(" ");
      i++;
    } else {
      i++;
    }
  }

  return chars.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/* ── OCR path ───────────────────────────────────────────────────────────── */

/**
 * Extract raw page images from DJVU IW44 chunks and OCR them.
 *
 * DJVU stores page images as IW44 wavelet-compressed data in BG44/FG44 chunks.
 * Since we don't have a pure-JS IW44 decoder, we extract any embedded JPEG/PNG
 * thumbnails (from TH44 chunks) or raw bitmap data for OCR.
 *
 * For best results with DJVU OCR, users should convert to PDF first using
 * djvulibre's `ddjvu -format=pdf input.djvu output.pdf` and then import
 * the PDF with OCR enabled.
 */
async function ocrDjvuPages(
  buf: Buffer,
  baseName: string,
  _pageCount: number,
  opts: ParseOptions,
  warnings: string[],
): Promise<ParseResult> {
  const thumbnails = extractThumbnails(buf);

  if (thumbnails.length === 0) {
    warnings.push(
      "DJVU has no text layer and no extractable thumbnails for OCR. " +
      "For best results, convert to PDF first: ddjvu -format=pdf input.djvu output.pdf",
    );
    return {
      metadata: { title: baseName, warnings },
      sections: [],
      rawCharCount: 0,
    };
  }

  const allParagraphs: Array<{ page: number; text: string }> = [];
  let totalChars = 0;
  let ocrPages = 0;

  for (const thumb of thumbnails) {
    if (opts.signal?.aborted) throw new Error("djvu OCR aborted");
    try {
      const result = await recognizeImageBuffer(
        new Uint8Array(thumb.data.buffer, thumb.data.byteOffset, thumb.data.byteLength),
        thumb.pageIndex,
        opts.ocrLanguages ?? [],
        opts.ocrAccuracy ?? "accurate",
        opts.signal,
      );
      const txt = result.text.trim();
      if (!txt) continue;
      const paragraphs = txt
        .split(/\n{2,}/)
        .map((p) => cleanParagraph(p))
        .filter((p) => p.length > 0);
      for (const para of paragraphs) {
        allParagraphs.push({ page: thumb.pageIndex + 1, text: para });
        totalChars += para.length;
      }
      ocrPages++;
    } catch (err) {
      warnings.push(`OCR failed on page ${thumb.pageIndex + 1}: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  if (ocrPages > 0) {
    warnings.push(`OCR applied to ${ocrPages} DJVU page thumbnail(s)`);
  } else {
    warnings.push("OCR ran on DJVU thumbnails but produced no text");
  }

  const sections = paragraphsToSections(allParagraphs);

  return {
    metadata: { title: baseName, warnings },
    sections,
    rawCharCount: totalChars,
  };
}

function extractThumbnails(buf: Buffer): Array<{ pageIndex: number; data: Buffer }> {
  const thumbs: Array<{ pageIndex: number; data: Buffer }> = [];
  let offset = 0;
  let pageIdx = 0;

  while (offset + 8 <= buf.length) {
    const tag = buf.subarray(offset, offset + 4).toString("ascii");

    if (tag === "TH44") {
      const size = buf.readUInt32BE(offset + 4);
      if (offset + 8 + size <= buf.length && size > 16) {
        thumbs.push({ pageIndex: pageIdx, data: buf.subarray(offset + 8, offset + 8 + size) });
      }
      offset += 8 + size + (size & 1);
      continue;
    }

    if (tag === "FORM" && offset + 12 <= buf.length) {
      const sub = buf.subarray(offset + 8, offset + 12).toString("ascii");
      if (sub === "DJVU") pageIdx++;
      offset += 12;
      continue;
    }

    if (tag === "AT&T") {
      offset += 4;
      continue;
    }

    if (offset + 8 > buf.length) break;
    const size = buf.readUInt32BE(offset + 4);
    offset += 8 + size + (size & 1);
  }

  return thumbs;
}

/* ── Text structuring helpers ───────────────────────────────────────────── */

function textToSections(text: string): BookSection[] {
  const blocks = text.split(/\n\s*\n/).map((b) => cleanParagraph(b)).filter(Boolean);
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let untitledIdx = 0;

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length === 1 && looksLikeHeading(lines[0])) {
      current = { level: 1, title: lines[0].trim(), paragraphs: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      untitledIdx++;
      current = { level: 1, title: `Section ${untitledIdx}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(block.replace(/\n/g, " "));
  }

  return sections.filter((s) => s.paragraphs.length > 0);
}

function paragraphsToSections(paragraphs: Array<{ page: number; text: string }>): BookSection[] {
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let lastPage = -1;

  for (const { page, text } of paragraphs) {
    if (page !== lastPage) {
      current = { level: 1, title: `Page ${page}`, paragraphs: [] };
      sections.push(current);
      lastPage = page;
    }
    if (looksLikeHeading(text) && text.length < 100) {
      current = { level: 1, title: text, paragraphs: [] };
      sections.push(current);
      continue;
    }
    current!.paragraphs.push(text);
  }

  return sections.filter((s) => s.paragraphs.length > 0);
}

function guessTitleFromText(text: string): string | null {
  const firstLine = text.split("\n").find((l) => l.trim().length > 3);
  if (firstLine && firstLine.trim().length < 120) return firstLine.trim();
  return null;
}

export const djvuParser: BookParser = { ext: "djvu", parse: parseDjvu };
