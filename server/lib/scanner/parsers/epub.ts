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

function metadataText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = metadataText(item);
      if (text) return text;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return metadataText(obj["#text"] ?? obj["text"] ?? obj["_"]);
  }
  return undefined;
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

function isHtmlLikeMediaType(mediaType: string): boolean {
  const normalized = mediaType.trim().toLowerCase();
  return normalized.includes("xhtml") || normalized === "text/html" || normalized === "application/html+xml";
}

/**
 * Жёсткий потолок RAM для EPUB (P1, симметрично PDF parser).
 * EPUB = ZIP, JSZip распаковывает ВЕСЬ архив в память. 250 MB EPUB
 * даёт ~750 MB пиковой RAM — приемлемо для 8+ GB машин. Увеличено
 * со 100 MB, так как ряд реальных книг (Kali Linux, Copilot Studio)
 * содержат встроенные изображения и превышают старый лимит.
 */
const MAX_EPUB_FILE_BYTES = 250 * 1024 * 1024;

async function parseEpub(filePath: string): Promise<ParseResult> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_EPUB_FILE_BYTES) {
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    const limitMb = (MAX_EPUB_FILE_BYTES / 1024 / 1024).toFixed(0);
    return {
      metadata: {
        title: path.basename(filePath, path.extname(filePath)),
        warnings: [`EPUB too large (${sizeMb} MB > ${limitMb} MB hard limit) — refused to parse`],
      },
      sections: [],
      rawCharCount: 0,
    };
  }
  const buf = await fs.readFile(filePath);
  /* Ловим ошибки JSZip отдельно: повреждённый ZIP, ZIP-bomb guard, неверная
     структура — всё это degrade до warnings + empty, как ODT делает с
     "ODT unzip failed". До этой правки JSZip throw'ил наружу → import-book
     помечал книгу как failed вместо unsupported. */
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      metadata: {
        title: path.basename(filePath, path.extname(filePath)),
        warnings: [`epub: ZIP load failed (${reason}) — file is corrupt or not a valid EPUB`],
      },
      sections: [],
      rawCharCount: 0,
    };
  }
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
    return metadataText(t) ?? path.basename(filePath, path.extname(filePath));
  })();
  const author = (() => {
    const a = md?.["dc:creator"] ?? md?.["creator"];
    return metadataText(a);
  })() || undefined;
  const language = (() => {
    const l = md?.["dc:language"] ?? md?.["language"];
    return metadataText(l)?.toLowerCase();
  })();

  const publisher = (() => {
    const p = md?.["dc:publisher"] ?? md?.["publisher"];
    return metadataText(p);
  })();

  const year = (() => {
    const d = md?.["dc:date"] ?? md?.["date"];
    const raw = metadataText(d) ?? "";
    const m = raw.match(/(\d{4})/);
    if (m) { const y = Number(m[1]); if (y >= 1800 && y <= 2100) return y; }
    return undefined;
  })();

  const identifier = (() => {
    const ids = asArray(md?.["dc:identifier"] ?? md?.["identifier"]);
    for (const raw of ids) {
      const text = metadataText(raw) ?? "";
      const digits = text.replace(/[-\s]/g, "");
      if (/^(978|979)\d{10}$/.test(digits)) return digits;
      if (/^\d{9}[\dXx]$/.test(digits)) return digits;
    }
    return undefined;
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
  /* path.posix умышленно: opfPath — это путь ВНУТРИ ZIP-архива, а ZIP
   * spec требует forward-slash separator вне зависимости от хоста. На
   * Windows path.dirname сделал бы backslash и манифест распарсился бы
   * криво. */
  const opfDir = path.posix.dirname(opfPath);
  const resolve = (href: string): string => {
    if (!opfDir || opfDir === ".") return href;
    return `${opfDir}/${href}`.replace(/\\/g, "/");
  };

  const spineNode = pkg?.["spine"] as Record<string, unknown> | undefined;
  let itemRefs = asArray(spineNode?.["itemref"]).map((ir) => String((ir as Record<string, unknown>)["@_idref"] ?? ""));
  if (itemRefs.length === 0) {
    /* Spine пустой — нестандартный EPUB. Fallback: собираем все xhtml/html
       items из manifest в порядке их объявления. */
    const fallbackIds = items
      .filter((i) => isHtmlLikeMediaType(i.mediaType))
      .map((i) => i.id);
    if (fallbackIds.length > 0) {
      itemRefs = fallbackIds;
      warnings.push("epub: spine was empty — falling back to manifest content items");
    } else {
      warnings.push("epub: empty spine and no xhtml items in manifest");
    }
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
    if (!item || !isHtmlLikeMediaType(item.mediaType)) continue;
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
    metadata: { title, author, language, identifier, year, publisher, warnings },
    sections,
    rawCharCount: totalChars,
  };
}

export const epubParser: BookParser = { ext: "epub", parse: parseEpub };
