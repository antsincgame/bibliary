import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, type BookParser, type ParseResult, type BookSection } from "./types.js";
import { pickBestBookTitle } from "../../library/title-heuristics.js";

/**
 * Legacy .doc parser — delegates to mammoth (same as DOCX; mammoth handles
 * both formats via the same API). Falls back to raw binary text extraction
 * when mammoth fails (common for very old .doc files).
 */
async function parseDoc(filePath: string): Promise<ParseResult> {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  const buf = await fs.readFile(filePath);
  const warnings: string[] = [];

  const styleMap: string[] = [
    "p[style-name='Heading 1'] => h1:fresh",
    "p[style-name='Heading 2'] => h2:fresh",
    "p[style-name='Heading 3'] => h3:fresh",
    "p[style-name='Title'] => h1:fresh",
  ];

  let html = "";
  try {
    const result = await (mammoth as unknown as {
      convertToHtml: (input: { buffer: Buffer }, opts: { styleMap: string[] }) => Promise<{
        value: string;
        messages: Array<{ type: string; message: string }>;
      }>;
    }).convertToHtml({ buffer: buf }, { styleMap });

    for (const m of result.messages) {
      if (m.type === "error" || m.type === "warning") warnings.push(`${m.type}: ${m.message}`);
    }
    html = result.value;
  } catch {
    warnings.push("mammoth failed for .doc, falling back to raw text extraction");
    return rawFallback(buf, filePath, warnings);
  }

  if (!html.trim()) {
    return rawFallback(buf, filePath, warnings);
  }

  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let totalChars = 0;
  let virtualIdx = 0;

  const tagRe = /<(h1|h2|h3|p)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = m[2]
      .replace(/<br\s*\/?>(\s*)/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
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
      current = { level: 1, title: `Section ${virtualIdx}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(cleaned);
    totalChars += cleaned.length;
  }

  const firstH1 = sections.find((s) => s.level === 1)?.title;
  const baseName = cleanDocTitle(path.basename(filePath, path.extname(filePath)));
  return {
    metadata: { title: pickBestBookTitle(firstH1, baseName) || baseName, warnings },
    sections: sections.filter((s) => s.paragraphs.length > 0),
    rawCharCount: totalChars,
  };
}

/** Strip common "Microsoft Word - " or "Document1 - " artifacts from .doc filenames. */
function cleanDocTitle(name: string): string {
  return name
    .replace(/^Microsoft\s+Word\s*[-–—]\s*/i, "")
    .replace(/^Document\d*\s*[-–—]\s*/i, "")
    .trim() || name;
}

function rawFallback(buf: Buffer, filePath: string, warnings: string[]): ParseResult {
  const raw = buf.toString("latin1");
  const textChunks: string[] = [];
  const re = /[\x20-\x7E\u00A0-\u00FF\u0400-\u04FF]{4,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) textChunks.push(m[0]);

  const text = textChunks.join(" ");
  const cleaned = cleanParagraph(text);
  const baseName = cleanDocTitle(path.basename(filePath, path.extname(filePath)));

  if (!cleaned) {
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  return {
    metadata: { title: baseName, warnings },
    sections: [{ level: 1, title: baseName, paragraphs: [cleaned] }],
    rawCharCount: cleaned.length,
  };
}

export const docParser: BookParser = { ext: "doc", parse: parseDoc };
