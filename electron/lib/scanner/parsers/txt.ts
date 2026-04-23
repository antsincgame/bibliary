import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseResult, type BookSection } from "./types.js";

const BOM = "\uFEFF";

/**
 * Эвристический TXT-парсер: разбивает по двойным переводам строк на параграфы,
 * группирует параграфы под heading-строками. Если headings не найдены — всё
 * сваливается в одну "виртуальную главу".
 */
async function parseTxt(filePath: string): Promise<ParseResult> {
  const buf = await fs.readFile(filePath);
  let text = buf.toString("utf8");
  if (text.startsWith(BOM)) text = text.slice(1);

  const warnings: string[] = [];
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
