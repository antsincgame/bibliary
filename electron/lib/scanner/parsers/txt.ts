import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseResult, type BookSection } from "./types.js";
import { decodeBuffer, detectBom } from "../encoding-detector.js";

const UTF8_BOM = "\uFEFF";

/**
 * Декодирует buffer в строку с авто-детектом кодировки.
 *
 * Phase A+B Iter 9.2 (rev. 2): семантика ИДЕНТИЧНА исторической реализации,
 * чтобы не ломать существующие тесты и потребителей. Новые парсеры (HTML/FB2)
 * используют `decodeBuffer` напрямую с расширенным API.
 *
 * Алгоритм:
 *   1. BOM detection (UTF-8 → "utf-8-bom", UTF-16 LE/BE → "utf-16le"/"utf-16be").
 *   2. UTF-16 без BOM heuristic: ≥10% NUL-байтов в первых 4 KB → "utf-16le-noBOM".
 *   3. UTF-8 default → "utf-8" (даже если файл pure ASCII).
 *   4. (Iter 9.2 rev. 2) если utf-8-decoded текст содержит много `\uFFFD`
 *      replacement chars — пробуем chardet как fallback (для русских торрент-
 *      дампов в windows-1251/KOI8-R/IBM866 без BOM/декларации).
 *
 * @param buf
 * @returns text — UTF-8 строка; encoding — для логов; warnings — диагностика.
 */
export function decodeTextAuto(buf: Buffer): { text: string; encoding: string; warnings: string[] } {
  const warnings: string[] = [];

  /* 1. BOM detection. Сохраняем historical encoding labels. */
  const bom = detectBom(buf);
  if (bom === "utf-8") {
    return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8-bom", warnings };
  }
  if (bom === "utf-16le") {
    return { text: buf.subarray(2).toString("utf16le"), encoding: "utf-16le", warnings };
  }
  if (bom === "utf-16be") {
    /* Node не имеет нативного utf16be — byte-swap. */
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]!;
      swapped[i - 1] = buf[i]!;
    }
    return { text: swapped.toString("utf16le"), encoding: "utf-16be", warnings };
  }

  /* 2. UTF-16 без BOM heuristic. */
  if (buf.length >= 16) {
    const sampleEnd = Math.min(buf.length, 4096);
    let nulBytes = 0;
    for (let i = 0; i < sampleEnd; i++) if (buf[i] === 0) nulBytes++;
    if (nulBytes / sampleEnd > 0.1) {
      warnings.push("auto-detected utf-16le (no BOM, but lots of NUL bytes)");
      return { text: buf.toString("utf16le"), encoding: "utf-16le-noBOM", warnings };
    }
  }

  /* 3. UTF-8 attempt. */
  const utf8 = buf.toString("utf8");
  if (utf8.startsWith(UTF8_BOM)) {
    /* Этот случай теоретически невозможен после BOM-check выше, но keep for safety. */
    return { text: utf8.slice(1), encoding: "utf-8-bom", warnings };
  }

  /* 4. (Iter 9.2 rev. 2) Если текст «грязный» (много \uFFFD = invalid UTF-8 sequences),
     значит файл скорее всего в одной из старых русских кодировок. Запускаем chardet. */
  if (buf.length >= 16 && countReplacementChars(utf8) > 5) {
    const detected = decodeBuffer(buf);
    if (detected.encoding !== "utf-8" && detected.source === "chardet") {
      warnings.push(`UTF-8 decode produced replacement chars; chardet → ${detected.encoding}`);
      return { text: detected.text, encoding: detected.encoding, warnings };
    }
  }

  return { text: utf8, encoding: "utf-8", warnings };
}

function countReplacementChars(s: string): number {
  let n = 0;
  for (let i = 0; i < Math.min(s.length, 4096); i++) {
    if (s.charCodeAt(i) === 0xfffd) n++;
  }
  return n;
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
