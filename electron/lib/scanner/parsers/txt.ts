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
  return {
    metadata: { title: baseName, warnings },
    sections,
    rawCharCount: text.length,
  };
}

export const txtParser: BookParser = { ext: "txt", parse: parseTxt };
