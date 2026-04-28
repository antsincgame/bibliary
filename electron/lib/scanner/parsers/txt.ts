import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseResult, type BookSection } from "./types.js";

const UTF8_BOM = "\uFEFF";

/**
 * Декодирует buffer в строку с авто-детектом кодировки по BOM:
 *   - UTF-16 LE  (FF FE)
 *   - UTF-16 BE  (FE FF)
 *   - UTF-8      (EF BB BF) — снимает BOM
 *   - default    UTF-8
 *
 * Если ни одной BOM нет — пробует UTF-8. Если результат содержит много
 * NUL-байтов (признак неправильно декодированного UTF-16 без BOM) —
 * фоллбэчится в UTF-16 LE (наиболее частый Windows-вариант).
 */
export function decodeTextAuto(buf: Buffer): { text: string; encoding: string; warnings: string[] } {
  const warnings: string[] = [];
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString("utf16le"), encoding: "utf-16le", warnings };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    /* UTF-16 BE: Node не имеет нативного `utf16be`, делаем byte-swap. */
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]!;
      swapped[i - 1] = buf[i]!;
    }
    return { text: swapped.toString("utf16le"), encoding: "utf-16be", warnings };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8-bom", warnings };
  }

  const utf8 = buf.toString("utf8");
  /* Эвристика: если в результате ≥10% NUL-байтов или replacement chars (\uFFFD)
     то это, вероятно, UTF-16 без BOM или один из 8-битных кодов. */
  if (buf.length >= 16) {
    const sampleEnd = Math.min(buf.length, 4096);
    let nulBytes = 0;
    for (let i = 0; i < sampleEnd; i++) if (buf[i] === 0) nulBytes++;
    if (nulBytes / sampleEnd > 0.1) {
      warnings.push("auto-detected utf-16le (no BOM, but lots of NUL bytes)");
      return { text: buf.toString("utf16le"), encoding: "utf-16le-noBOM", warnings };
    }
  }
  if (utf8.startsWith(UTF8_BOM)) return { text: utf8.slice(1), encoding: "utf-8-bom", warnings };
  return { text: utf8, encoding: "utf-8", warnings };
}

/**
 * Эвристический TXT-парсер: разбивает по двойным переводам строк на параграфы,
 * группирует параграфы под heading-строками. Если headings не найдены — всё
 * сваливается в одну "виртуальную главу".
 */
async function parseTxt(filePath: string): Promise<ParseResult> {
  const buf = await fs.readFile(filePath);
  const decoded = decodeTextAuto(buf);
  const text = decoded.text;
  const warnings: string[] = [...decoded.warnings];
  if (decoded.encoding !== "utf-8") {
    warnings.push(`detected encoding: ${decoded.encoding}`);
  }
  if (text.length === 0) {
    warnings.push("empty file");
  }

  const blocks = text.split(/\n\s*\n/).map((b) => cleanParagraph(b)).filter(Boolean);
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let untitledIdx = 0;

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length === 1 && looksLikeHeading(lines[0])) {
      current = { level: 1, title: lines[0].trim(), paragraphs: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      untitledIdx++;
      current = { level: 1, title: `Section ${untitledIdx}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(block.replace(/\n/g, " "));
  }

  const baseName = path.basename(filePath, path.extname(filePath));

  const merged = mergeHeadingOnlySections(sections);

  return {
    metadata: { title: baseName, warnings },
    sections: merged,
    rawCharCount: text.length,
  };
}

/**
 * Heading-only секции (пустые `paragraphs`) мержим с ближайшей
 * следующей секцией, у которой есть текст. Заголовки объединяем
 * через " / ". Если все секции пустые -- возвращаем как есть.
 */
function mergeHeadingOnlySections(sections: BookSection[]): BookSection[] {
  const out: BookSection[] = [];
  let pendingTitles: string[] = [];

  for (const sec of sections) {
    if (sec.paragraphs.length === 0) {
      pendingTitles.push(sec.title);
      continue;
    }
    if (pendingTitles.length > 0) {
      sec.title = [...pendingTitles, sec.title].join(" / ");
      pendingTitles = [];
    }
    out.push(sec);
  }
  if (pendingTitles.length > 0) {
    if (out.length > 0) {
      out[out.length - 1].title += " / " + pendingTitles.join(" / ");
    } else {
      out.push({ level: 1, title: pendingTitles.join(" / "), paragraphs: [] });
    }
  }
  return out;
}

export const txtParser: BookParser = { ext: "txt", parse: parseTxt };
