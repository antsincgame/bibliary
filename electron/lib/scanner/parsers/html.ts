import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, type BookParser, type ParseResult, type BookSection } from "./types.js";

/**
 * HTML/HTM parser — reads the file, extracts <title>, then splits body
 * content by heading tags (h1-h3) into sections with paragraphs.
 * No external dependency.
 */
async function parseHtml(filePath: string): Promise<ParseResult> {
  const buf = await fs.readFile(filePath);
  let text = buf.toString("utf8");
  const warnings: string[] = [];

  const charsetMatch = text.match(/<meta[^>]+charset=["']?([^"';\s>]+)/i);
  if (charsetMatch) {
    const charsetRaw = charsetMatch[1].toLowerCase();
    /* Node ships with built-in `TextDecoder` powered by the WHATWG Encoding
       Standard. It supports windows-1251, koi8-r, iso-8859-*, etc. — all the
       Cyrillic encodings real-world HTML books use. Falling back to UTF-8 if
       the label is unknown keeps the parser tolerant. */
    if (charsetRaw && charsetRaw !== "utf-8" && charsetRaw !== "utf8") {
      try {
        const decoder = new TextDecoder(charsetRaw, { fatal: false });
        text = decoder.decode(buf);
        warnings.push(`detected charset ${charsetRaw}, decoded via TextDecoder`);
      } catch {
        warnings.push(`unsupported charset ${charsetRaw}, kept utf-8 decoding`);
      }
    }
  }

  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? cleanParagraph(stripTags(titleMatch[1])) || path.basename(filePath, path.extname(filePath))
    : path.basename(filePath, path.extname(filePath));

  const bodyMatch = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : text;

  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let totalChars = 0;
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
      current = { level: 1, title: `Section ${virtualIdx}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(cleaned);
    totalChars += cleaned.length;
  }

  if (sections.length === 0) {
    const plainText = cleanParagraph(stripTags(body));
    if (plainText && plainText.length > 50) {
      sections.push({ level: 1, title: title, paragraphs: [plainText] });
      totalChars = plainText.length;
    }
  }

  return {
    metadata: { title, warnings },
    sections: sections.filter((s) => s.paragraphs.length > 0),
    rawCharCount: totalChars,
  };
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export const htmlParser: BookParser = { ext: "html", parse: parseHtml };
export const htmParser: BookParser = { ext: "htm", parse: parseHtml };
