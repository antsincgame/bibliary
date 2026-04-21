import * as path from "path";
import { promises as fs } from "fs";
import type { BookParser, ParseResult, SupportedExt } from "./types.js";
import { txtParser } from "./txt.js";
import { pdfParser } from "./pdf.js";
import { fb2Parser } from "./fb2.js";
import { docxParser } from "./docx.js";
import { epubParser } from "./epub.js";

export type { BookParser, ParseResult, BookSection, BookMetadata, SupportedExt } from "./types.js";

const PARSERS: Record<SupportedExt, BookParser> = {
  pdf: pdfParser,
  epub: epubParser,
  fb2: fb2Parser,
  docx: docxParser,
  txt: txtParser,
};

const SUPPORTED: ReadonlySet<string> = new Set<string>(Object.keys(PARSERS));

export function detectExt(filePath: string): SupportedExt | null {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return SUPPORTED.has(ext) ? (ext as SupportedExt) : null;
}

export function isSupportedBook(filePath: string): boolean {
  return detectExt(filePath) !== null;
}

export async function parseBook(filePath: string): Promise<ParseResult> {
  const ext = detectExt(filePath);
  if (!ext) throw new Error(`unsupported book extension: ${path.extname(filePath)}`);
  return PARSERS[ext].parse(filePath);
}

export interface BookFileSummary {
  absPath: string;
  fileName: string;
  ext: SupportedExt;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Просканировать директорию (рекурсивно, с capped depth) и вернуть список
 * поддерживаемых файлов с базовой метаинформацией. Не парсит файлы.
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
