import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, type BookParser, type ParseResult, type BookSection } from "./types.js";

/**
 * DOCX-парсер на mammoth. Mammoth даёт нам raw HTML с нашими стилями,
 * мы конвертируем h1/h2/h3 → BookSection (level 1/2/3), <p> → paragraph.
 */
async function parseDocx(filePath: string): Promise<ParseResult> {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  const buf = await fs.readFile(filePath);
  const warnings: string[] = [];

  const styleMap: string[] = [
    "p[style-name='Heading 1'] => h1:fresh",
    "p[style-name='Heading 2'] => h2:fresh",
    "p[style-name='Heading 3'] => h3:fresh",
    "p[style-name='Title'] => h1:fresh",
  ];

  const result = await (mammoth as unknown as {
    convertToHtml: (input: { buffer: Buffer }, opts: { styleMap: string[] }) => Promise<{
      value: string;
      messages: Array<{ type: string; message: string }>;
    }>;
  }).convertToHtml({ buffer: buf }, { styleMap });

  for (const m of result.messages) {
    if (m.type === "error" || m.type === "warning") warnings.push(`${m.type}: ${m.message}`);
  }

  const html = result.value;
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
      current = { level: 1, title: `Раздел ${virtualIdx}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(cleaned);
    totalChars += cleaned.length;
  }

  const baseName = path.basename(filePath, path.extname(filePath));
  return {
    metadata: { title: baseName, warnings },
    sections: sections.filter((s) => s.paragraphs.length > 0),
    rawCharCount: totalChars,
  };
}

export const docxParser: BookParser = { ext: "docx", parse: parseDocx };
