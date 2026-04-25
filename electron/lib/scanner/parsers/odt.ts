import { promises as fs } from "fs";
import * as path from "path";
import JSZip from "jszip";
import { cleanParagraph, type BookParser, type ParseResult, type BookSection } from "./types.js";

/**
 * ODT parser — OpenDocument Text is a ZIP containing content.xml.
 * We extract text:h (headings) and text:p (paragraphs) via regex
 * on the XML. No external dependency beyond jszip (already installed).
 */
async function parseOdt(filePath: string): Promise<ParseResult> {
  const buf = await fs.readFile(filePath);
  const warnings: string[] = [];
  let xml = "";

  try {
    const zip = await JSZip.loadAsync(buf);
    const contentEntry = zip.file("content.xml");
    if (!contentEntry) {
      warnings.push("content.xml not found in ODT archive");
      return emptyResult(filePath, warnings);
    }
    xml = await contentEntry.async("string");
  } catch (e) {
    warnings.push(`ODT unzip failed: ${e instanceof Error ? e.message : String(e)}`);
    return emptyResult(filePath, warnings);
  }

  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let totalChars = 0;
  let virtualIdx = 0;

  const elementRe = /<text:(h|p)\b[^>]*>([\s\S]*?)<\/text:\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(xml)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = stripXmlTags(m[2]);
    const cleaned = cleanParagraph(inner);
    if (!cleaned) continue;

    if (tag === "h") {
      current = { level: 1, title: cleaned, paragraphs: [] };
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

  const baseName = path.basename(filePath, path.extname(filePath));
  return {
    metadata: { title: baseName, warnings },
    sections: sections.filter((s) => s.paragraphs.length > 0),
    rawCharCount: totalChars,
  };
}

function stripXmlTags(xml: string): string {
  return xml
    .replace(/<text:s\s*\/>/g, " ")
    .replace(/<text:tab\s*\/>/g, "\t")
    .replace(/<text:line-break\s*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function emptyResult(filePath: string, warnings: string[]): ParseResult {
  return {
    metadata: { title: path.basename(filePath, path.extname(filePath)), warnings },
    sections: [],
    rawCharCount: 0,
  };
}

export const odtParser: BookParser = { ext: "odt", parse: parseOdt };
