import { promises as fs } from "fs";
import * as path from "path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { cleanParagraph, type BookParser, type ParseResult, type BookSection } from "./types.js";

/**
 * EPUB-парсер: ZIP → container.xml → OPF (manifest+spine) → читаем XHTML
 * в порядке spine, NCX/NAV TOC даёт нам heading иерархию.
 *
 * Без сторонних epub-SDK — JSZip + fast-xml-parser. Это даёт максимальную
 * прозрачность и позволяет работать с EPUB 2 и 3 одновременно.
 */

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

function decodeText(html: string): string {
  return html
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/?(p|div|section|article|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

async function parseEpub(filePath: string): Promise<ParseResult> {
  const buf = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const warnings: string[] = [];

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("epub: no META-INF/container.xml");
  const containerXml = await containerFile.async("string");
  const container = xmlParser.parse(containerXml) as Record<string, unknown>;
  const rootfiles = (container?.["container"] as Record<string, unknown>)?.["rootfiles"] as Record<string, unknown> | undefined;
  const rootfileNode = rootfiles?.["rootfile"];
  const rootfileObj = (Array.isArray(rootfileNode) ? rootfileNode[0] : rootfileNode) as Record<string, unknown> | undefined;
  const opfPath = rootfileObj?.["@_full-path"] as string | undefined;
  if (!opfPath) throw new Error("epub: rootfile not found");

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error(`epub: missing OPF at ${opfPath}`);
  const opfXml = await opfFile.async("string");
  const opf = xmlParser.parse(opfXml) as Record<string, unknown>;
  const pkg = opf?.["package"] as Record<string, unknown> | undefined;

  const md = pkg?.["metadata"] as Record<string, unknown> | undefined;
  const title = (() => {
    const t = md?.["dc:title"] ?? md?.["title"];
    if (!t) return path.basename(filePath, path.extname(filePath));
    return typeof t === "string" ? t : (Array.isArray(t) ? String(t[0]) : String((t as Record<string, unknown>)["#text"] ?? path.basename(filePath, path.extname(filePath))));
  })();
  const author = (() => {
    const a = md?.["dc:creator"] ?? md?.["creator"];
    if (!a) return undefined;
    if (typeof a === "string") return a;
    if (Array.isArray(a)) return String(a[0]);
    return String((a as Record<string, unknown>)["#text"] ?? "");
  })() || undefined;
  const language = (() => {
    const l = md?.["dc:language"] ?? md?.["language"];
    if (!l) return undefined;
    return typeof l === "string" ? l.toLowerCase() : undefined;
  })();

  const manifestRaw = (pkg?.["manifest"] as Record<string, unknown> | undefined)?.["item"];
  const items: ManifestItem[] = asArray(manifestRaw).map((it) => {
    const o = it as Record<string, unknown>;
    return {
      id: String(o["@_id"] ?? ""),
      href: String(o["@_href"] ?? ""),
      mediaType: String(o["@_media-type"] ?? ""),
    };
  });
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const opfDir = path.posix.dirname(opfPath);
  const resolve = (href: string): string => {
    if (!opfDir || opfDir === ".") return href;
    return `${opfDir}/${href}`.replace(/\\/g, "/");
  };

  const spineNode = pkg?.["spine"] as Record<string, unknown> | undefined;
  const itemRefs = asArray(spineNode?.["itemref"]).map((ir) => String((ir as Record<string, unknown>)["@_idref"] ?? ""));
  if (itemRefs.length === 0) {
    warnings.push("epub: empty spine");
  }

  const headingByHref = new Map<string, string>();
  const tocItem = items.find((i) => i.mediaType === "application/x-dtbncx+xml") ?? items.find((i) => i.id === "ncx");
  if (tocItem) {
    const ncxFile = zip.file(resolve(tocItem.href));
    if (ncxFile) {
      try {
        const ncxXml = await ncxFile.async("string");
        const ncx = xmlParser.parse(ncxXml) as Record<string, unknown>;
        const navMap = (ncx?.["ncx"] as Record<string, unknown> | undefined)?.["navMap"] as Record<string, unknown> | undefined;
        const navPoints = asArray(navMap?.["navPoint"]);
        const collect = (nodes: unknown[]): void => {
          for (const np of nodes) {
            const o = np as Record<string, unknown>;
            const label = (o["navLabel"] as Record<string, unknown> | undefined)?.["text"];
            const labelStr = typeof label === "string" ? label : String((label as Record<string, unknown>)?.["#text"] ?? "");
            const content = o["content"] as Record<string, unknown> | undefined;
            const src = String(content?.["@_src"] ?? "").split("#")[0];
            if (src && labelStr) headingByHref.set(src, labelStr);
            const children = asArray(o["navPoint"]);
            if (children.length) collect(children);
          }
        };
        collect(navPoints);
      } catch {
        warnings.push("epub: NCX parse failed");
      }
    }
  }

  const sections: BookSection[] = [];
  let totalChars = 0;
  let virtualIdx = 0;

  for (const idref of itemRefs) {
    const item = itemById.get(idref);
    if (!item || !item.mediaType.includes("xhtml")) continue;
    const file = zip.file(resolve(item.href));
    if (!file) {
      warnings.push(`epub: missing spine item ${item.href}`);
      continue;
    }
    const html = await file.async("string");
    const heading = headingByHref.get(item.href) ?? null;
    const text = decodeText(html);
    const paragraphs = text
      .split(/\n+/)
      .map((p) => cleanParagraph(p))
      .filter((p) => p.length > 0);
    if (paragraphs.length === 0) continue;
    let title: string;
    if (heading) {
      title = heading;
    } else {
      virtualIdx++;
      title = `Часть ${virtualIdx}`;
    }
    for (const p of paragraphs) totalChars += p.length;
    sections.push({ level: 1, title, paragraphs });
  }

  return {
    metadata: { title, author, language, warnings },
    sections,
    rawCharCount: totalChars,
  };
}

export const epubParser: BookParser = { ext: "epub", parse: parseEpub };
