/**
 * Composite HTML Book Detector & Assembler.
 *
 * Problem: Old technical references (Perl in a Nutshell, MSDN dumps, O'Reilly
 * CD-ROMs) consist of hundreds of small HTML files — one per chapter section.
 * These are NOT noise; they are valuable books in a fragmented form.
 *
 * Previous behaviour: all these files were rejected by the HTML filter (too
 * small per file, or too deep in directory).
 *
 * New behaviour:
 *   1. walkSupportedFiles encounters a directory with >10 HTML files.
 *   2. CompositeHtmlDetector detects it and yields ONE CompositeHtmlBook
 *      representing the whole directory.
 *   3. assembleCompositeHtmlBook assembles all pages into a single ParseResult,
 *      respecting chapter order from index.html (if present) or alphabetical sort.
 *
 * Integration points:
 *   - file-walker.ts: yields directories with HTML clusters via walkHtmlDirs()
 *   - import.ts expandTasks(): calls detectCompositeHtmlDir() on each HTML directory
 *   - md-converter.ts: given a "composite-html" virtual format, calls assembleCompositeHtmlBook
 */

import { promises as fs } from "fs";
import * as path from "path";
import type { ParseResult, BookSection } from "../../parsers/types.js";
import { cleanParagraph } from "../../parsers/types.js";
import { decodeBuffer } from "../../encoding-detector.js";

/** Minimum number of HTML files to treat as a composite book (not a single doc). */
const MIN_HTML_FILES_FOR_COMPOSITE = 10;

export interface CompositeHtmlBook {
  /** Absolute path to the directory containing HTML files. */
  dirPath: string;
  /** Ordered list of HTML files to assemble (absolute paths). */
  files: string[];
  /** Entry point file, if discovered (index.html / toc.html / etc). */
  entryPoint: string | null;
  /** Inferred book title from entry point or dir name. */
  inferredTitle: string;
}

/** Candidate filenames that act as entry points / TOC. */
const ENTRY_POINT_NAMES = new Set([
  "index.html", "index.htm",
  "toc.html", "toc.htm",
  "main.html", "main.htm",
  "start.html", "start.htm",
  "home.html", "home.htm",
]);

/**
 * Scan a directory and, if it qualifies as a Composite HTML Book, return
 * metadata describing it. Returns null otherwise.
 */
export async function detectCompositeHtmlDir(dirPath: string): Promise<CompositeHtmlBook | null> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const htmlFiles: string[] = [];
  let entryPoint: string | null = null;

  for (const e of entries) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (!lower.endsWith(".html") && !lower.endsWith(".htm")) continue;
    const abs = path.join(dirPath, e.name);
    htmlFiles.push(abs);
    if (entryPoint === null && ENTRY_POINT_NAMES.has(lower)) {
      entryPoint = abs;
    }
  }

  if (htmlFiles.length < MIN_HTML_FILES_FOR_COMPOSITE) return null;

  // Order: if entry point exists, parse it to extract link order; otherwise sort alphabetically.
  const ordered = entryPoint
    ? await orderByEntryPoint(entryPoint, htmlFiles)
    : htmlFiles.slice().sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));

  // Title: from entry-point <title> or directory name
  const inferredTitle = entryPoint
    ? await extractHtmlTitle(entryPoint) ?? inferTitleFromDir(dirPath)
    : inferTitleFromDir(dirPath);

  return { dirPath, files: ordered, entryPoint, inferredTitle };
}

/**
 * Assemble a CompositeHtmlBook into a single ParseResult.
 * Used by md-converter instead of a format-specific parser.
 */
export async function assembleCompositeHtmlBook(book: CompositeHtmlBook): Promise<ParseResult> {
  const sections: BookSection[] = [];
  let totalChars = 0;
  const warnings: string[] = [];

  // Add a synthetic top-level section header per file (= chapter)
  for (const filePath of book.files) {
    let text: string;
    try {
      const buf = await fs.readFile(filePath);
      text = decodeHtmlBuffer(buf);
    } catch {
      warnings.push(`composite-html: could not read ${path.basename(filePath)}`);
      continue;
    }

    const fileSections = extractSectionsFromHtml(text, filePath);
    for (const s of fileSections) {
      sections.push(s);
      for (const p of s.paragraphs) totalChars += p.length;
    }
  }

  if (sections.length === 0) {
    warnings.push("composite-html: no content extracted from any file");
  }

  return {
    metadata: {
      title: book.inferredTitle,
      warnings,
    },
    sections,
    rawCharCount: totalChars,
  };
}

// ─────────────────────────── internal helpers ───────────────────────────

function inferTitleFromDir(dirPath: string): string {
  const name = path.basename(dirPath);
  // Strip trailing path-safe chars, replace _ and - with spaces
  return name.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim() || name;
}

async function extractHtmlTitle(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath);
    const text = decodeHtmlBuffer(raw);
    const m = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return null;
    const t = cleanParagraph(stripTags(m[1]));
    return t.length > 2 ? t : null;
  } catch {
    return null;
  }
}

/**
 * Extract chapter order from entry-point HTML: parse <a href="*.html"> links
 * in document order. Files not referenced in the TOC are appended at the end.
 */
async function orderByEntryPoint(entryPath: string, allFiles: string[]): Promise<string[]> {
  try {
    const raw = await fs.readFile(entryPath);
    const text = decodeHtmlBuffer(raw);
    const dir = path.dirname(entryPath);

    const ordered: string[] = [];
    const seen = new Set<string>();

    const linkRe = /href=["']([^"'#?]+\.html?)[^"']*["']/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(text)) !== null) {
      const href = m[1];
      const abs = path.resolve(dir, href);
      if (!seen.has(abs)) {
        seen.add(abs);
        if (allFiles.includes(abs)) {
          ordered.push(abs);
        }
      }
    }

    // Append any files not referenced in the TOC
    for (const f of allFiles) {
      if (!seen.has(f) && f !== entryPath) {
        ordered.push(f);
      }
    }

    return ordered.length > 0 ? ordered : allFiles.slice().sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
  } catch {
    return allFiles.slice().sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
  }
}

function decodeHtmlBuffer(buf: Buffer): string {
  return decodeBuffer(buf, { parseHtmlMeta: true }).text;
}

function extractSectionsFromHtml(text: string, filePath: string): BookSection[] {
  const bodyMatch = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : text;

  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let virtualIdx = 0;

  const re = /<(h[1-3]|p|div|li|blockquote|td|th|dt|dd|article|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = stripTags(m[2]);
    const cleaned = cleanParagraph(inner);
    if (!cleaned) continue;

    if (tag === "h1" || tag === "h2" || tag === "h3") {
      const level = (tag === "h1" ? 1 : tag === "h2" ? 2 : 3) as 1 | 2 | 3;
      current = { level, title: cleaned, paragraphs: [] };
      sections.push(current);
      continue;
    }

    if (!current) {
      virtualIdx++;
      const fallbackTitle = `${path.basename(filePath, path.extname(filePath))} §${virtualIdx}`;
      current = { level: 2, title: fallbackTitle, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(cleaned);
  }

  // If regex missed content (e.g. no matched block tags), extract plain text
  if (sections.length === 0) {
    const plainText = cleanParagraph(stripTags(body));
    if (plainText && plainText.length > 50) {
      const title = path.basename(filePath, path.extname(filePath));
      sections.push({ level: 2, title, paragraphs: [plainText] });
    }
  }

  return sections.filter((s) => s.paragraphs.length > 0);
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|dt|dd)>/gi, "\n")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Natural sort: "c02_001" < "c02_002" < "c10_001". */
function naturalCompare(a: string, b: string): number {
  const re = /(\d+)/;
  const aParts = a.split(re);
  const bParts = b.split(re);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] ?? "";
    const bp = bParts[i] ?? "";
    const an = Number(ap);
    const bn = Number(bp);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = ap.localeCompare(bp);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}
