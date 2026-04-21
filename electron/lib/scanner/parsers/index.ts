import * as path from "path";
import { promises as fs } from "fs";
import type { BookParser, ParseOptions, ParseResult, SupportedExt } from "./types.js";
import { txtParser } from "./txt.js";
import { pdfParser } from "./pdf.js";
import { fb2Parser } from "./fb2.js";
import { docxParser } from "./docx.js";
import { epubParser } from "./epub.js";
import { imageParser } from "./image.js";

export type { BookParser, ParseOptions, ParseResult, BookSection, BookMetadata, SupportedExt } from "./types.js";

const PARSERS: Record<SupportedExt, BookParser> = {
  pdf: pdfParser,
  epub: epubParser,
  fb2: fb2Parser,
  docx: docxParser,
  txt: txtParser,
  png: imageParser,
  jpg: imageParser,
  jpeg: imageParser,
  bmp: imageParser,
  tif: imageParser,
  tiff: imageParser,
  webp: imageParser,
};

const SUPPORTED: ReadonlySet<string> = new Set<string>(Object.keys(PARSERS));

const IMAGE_EXTS: ReadonlySet<SupportedExt> = new Set([
  "png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp",
]);

export function detectExt(filePath: string): SupportedExt | null {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return SUPPORTED.has(ext) ? (ext as SupportedExt) : null;
}

export function isSupportedBook(filePath: string): boolean {
  return detectExt(filePath) !== null;
}

export function isImageExt(ext: SupportedExt): boolean {
  return IMAGE_EXTS.has(ext);
}

export async function parseBook(filePath: string, opts?: ParseOptions): Promise<ParseResult> {
  const ext = detectExt(filePath);
  if (!ext) throw new Error(`unsupported book extension: ${path.extname(filePath)}`);
  return PARSERS[ext].parse(filePath, opts);
}

export interface BookFileSummary {
  absPath: string;
  fileName: string;
  ext: SupportedExt;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Scan a directory recursively (capped depth) and return supported files
 * with basic metadata. Does not parse anything.
 */
export async function probeBooks(rootDir: string, maxDepth = 4): Promise<BookFileSummary[]> {
  const out: BookFileSummary[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = detectExt(e.name);
        if (!ext) continue;
        try {
          const st = await fs.stat(full);
          out.push({
            absPath: full,
            fileName: e.name,
            ext,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(rootDir, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Convert an arbitrary list of absolute file paths into BookFileSummary[].
 * Used by drag&drop and multi-file open dialogs (Phase 6.0).
 *
 * - Skips non-files / unsupported extensions silently
 * - Deduplicates paths
 * - Returns sorted by mtimeMs desc to match probeBooks() shape
 */
export async function probeFiles(absPaths: string[]): Promise<BookFileSummary[]> {
  const seen = new Set<string>();
  const out: BookFileSummary[] = [];
  for (const p of absPaths) {
    if (typeof p !== "string" || p.length === 0) continue;
    const normalised = path.resolve(p);
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    const ext = detectExt(normalised);
    if (!ext) continue;
    let st: import("fs").Stats;
    try {
      st = await fs.stat(normalised);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      absPath: normalised,
      fileName: path.basename(normalised),
      ext,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
