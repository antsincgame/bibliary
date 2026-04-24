import { promises as fs } from "fs";
import * as path from "path";
import { XMLParser } from "fast-xml-parser";
import { cleanParagraph, type BookParser, type ParseResult, type BookSection } from "./types.js";

interface Fb2Section {
  title?: { p?: string | string[] | { "#text"?: string } } | string;
  p?: string | string[] | Array<string | { "#text"?: string }>;
  section?: Fb2Section | Fb2Section[];
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function extractText(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(" ");
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
    return Object.entries(obj)
      .filter(([k]) => !k.startsWith("@_"))
      .map(([, v]) => extractText(v))
      .join(" ");
  }
  return "";
}

function flattenSection(section: Fb2Section, level: 1 | 2 | 3): BookSection[] {
  const titleText = section.title ? extractText(section.title).trim() : "";
  const paragraphs: string[] = asArray(section.p)
    .map((p) => cleanParagraph(extractText(p)))
    .filter((p) => p.length > 0);

  const out: BookSection[] = [];
  out.push({ level, title: titleText || `Section`, paragraphs });

  for (const child of asArray(section.section)) {
    const nextLevel = (Math.min(level + 1, 3)) as 1 | 2 | 3;
    out.push(...flattenSection(child, nextLevel));
  }
  return out;
}

async function parseFb2(filePath: string): Promise<ParseResult> {
  const buf = await fs.readFile(filePath);
  let xml = buf.toString("utf8");
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);

  const warnings: string[] = [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: true,
    trimValues: true,
    processEntities: true,
    htmlEntities: true,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`fb2 parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const root = (parsed["FictionBook"] ?? parsed["fictionbook"]) as Record<string, unknown> | undefined;
  if (!root) {
    warnings.push("FictionBook root not found");
    return {
      metadata: { title: path.basename(filePath, path.extname(filePath)), warnings },
      sections: [],
      rawCharCount: 0,
    };
  }

  const description = root["description"] as Record<string, unknown> | undefined;
  const titleInfo = (description?.["title-info"] ?? description?.["titleInfo"]) as Record<string, unknown> | undefined;
  let title = path.basename(filePath, path.extname(filePath));
  let author: string | undefined;
  let language: string | undefined;
  if (titleInfo) {
    const bookTitle = titleInfo["book-title"];
    if (bookTitle) title = extractText(bookTitle).trim() || title;
    const authorNode = titleInfo["author"];
    if (authorNode) {
      const a = Array.isArray(authorNode) ? authorNode[0] : authorNode;
      const ao = a as Record<string, unknown>;
      const first = extractText(ao?.["first-name"]).trim();
      const last = extractText(ao?.["last-name"]).trim();
      author = [first, last].filter(Boolean).join(" ") || undefined;
    }
    const lang = titleInfo["lang"];
    if (lang) language = String(lang).toLowerCase();
  }

  const publishInfo = (description?.["publish-info"] ?? description?.["publishInfo"]) as Record<string, unknown> | undefined;
  let year: number | undefined;
  let isbn: string | undefined;
  let publisher: string | undefined;
  if (publishInfo) {
    const yRaw = publishInfo["year"];
    if (yRaw !== undefined) {
      const yn = typeof yRaw === "number" ? yRaw : Number(String(yRaw).match(/(\d{4})/)?.[1]);
      if (yn >= 1800 && yn <= 2100) year = yn;
    }
    const isbnRaw = publishInfo["isbn"];
    if (isbnRaw) {
      const digits = String(isbnRaw).replace(/[-\s]/g, "");
      if (/^(978|979)\d{10}$/.test(digits) || /^\d{9}[\dXx]$/.test(digits)) isbn = digits;
    }
    const pubRaw = publishInfo["publisher"];
    if (pubRaw) publisher = extractText(pubRaw).trim() || undefined;
  }

  const body = root["body"];
  const bodies = asArray(body) as Fb2Section[];
  let totalChars = 0;
  const sections: BookSection[] = [];
  for (const b of bodies) {
    for (const sec of asArray(b.section)) {
      const flat = flattenSection(sec, 1);
      for (const s of flat) {
        for (const p of s.paragraphs) totalChars += p.length;
      }
      sections.push(...flat);
    }
  }

  return {
    metadata: { title, author, language, identifier: isbn, year, publisher, warnings },
    sections: sections.filter((s) => s.paragraphs.length > 0),
    rawCharCount: totalChars,
  };
}

export const fb2Parser: BookParser = { ext: "fb2", parse: parseFb2 };
