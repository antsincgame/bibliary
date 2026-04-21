import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseResult, type BookSection } from "./types.js";

/**
 * PDF-парсер на pdfjs-dist (legacy build, не требует canvas/worker).
 * Извлекает текст по страницам, склеивает в параграфы (heuristic по
 * межстрочным интервалам), пытается реконструировать главы из TOC outline.
 *
 * Не делает OCR: если PDF — только сканы изображений, текста не будет.
 * В этом случае sections останется пустым, warnings содержит "no text".
 */
async function parsePdf(filePath: string): Promise<ParseResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const buf = await fs.readFile(filePath);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });

  const warnings: string[] = [];
  let doc: Awaited<typeof loadingTask.promise>;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    /* PasswordException, InvalidPDFException, MissingPDFException и пр. */
    const name = err instanceof Error ? err.name : "Error";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "PasswordException" || /password/i.test(msg)) {
      return {
        metadata: {
          title: path.basename(filePath, path.extname(filePath)),
          warnings: [`PDF protected by password — skipped (${msg.slice(0, 120)})`],
        },
        sections: [],
        rawCharCount: 0,
      };
    }
    return {
      metadata: {
        title: path.basename(filePath, path.extname(filePath)),
        warnings: [`PDF parse failed (${name}): ${msg.slice(0, 200)}`],
      },
      sections: [],
      rawCharCount: 0,
    };
  }
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const title = (typeof info.Title === "string" && info.Title.trim()) || path.basename(filePath, path.extname(filePath));
  const author = typeof info.Author === "string" && info.Author.trim() ? String(info.Author) : undefined;
  const language = typeof info.Language === "string" ? String(info.Language) : undefined;

  let outline: Awaited<ReturnType<typeof doc.getOutline>> | null = null;
  try {
    outline = await doc.getOutline();
  } catch {
    /* noop */
  }

  const allParagraphs: Array<{ page: number; text: string }> = [];
  let totalChars = 0;
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();
    const items = tc.items as Array<{ str: string; transform: number[]; hasEOL?: boolean }>;
    let buffer = "";
    let lastY: number | null = null;
    for (const it of items) {
      const y = it.transform?.[5];
      if (lastY !== null && typeof y === "number" && Math.abs(lastY - y) > 14) {
        if (buffer.trim()) {
          const cleaned = cleanParagraph(buffer);
          if (cleaned) {
            allParagraphs.push({ page: pageNum, text: cleaned });
            totalChars += cleaned.length;
          }
          buffer = "";
        }
      }
      buffer += it.str;
      if (it.hasEOL) buffer += " ";
      else buffer += " ";
      lastY = typeof y === "number" ? y : lastY;
    }
    if (buffer.trim()) {
      const cleaned = cleanParagraph(buffer);
      if (cleaned) {
        allParagraphs.push({ page: pageNum, text: cleaned });
        totalChars += cleaned.length;
      }
    }
    page.cleanup();
  }

  if (allParagraphs.length === 0) {
    warnings.push("no text extracted (likely a scanned/image PDF — OCR not enabled)");
  }

  const sections: BookSection[] = [];

  if (outline && outline.length > 0) {
    let chapterIdx = 0;
    let chapter: BookSection | null = null;
    let cursor = 0;
    for (const entry of outline) {
      const heading = String(entry.title ?? "").trim();
      if (!heading) continue;
      chapterIdx++;
      const matchIdx = allParagraphs.findIndex((p, idx) => idx >= cursor && p.text.toLowerCase().includes(heading.toLowerCase().slice(0, 40)));
      if (chapter) sections.push(chapter);
      chapter = { level: 1, title: heading, paragraphs: [] };
      const sliceStart = matchIdx >= 0 ? matchIdx : cursor;
      const sliceEnd = (chapterIdx < outline.length) ? Math.min(sliceStart + Math.max(20, allParagraphs.length / outline.length), allParagraphs.length) : allParagraphs.length;
      for (let i = sliceStart; i < sliceEnd; i++) chapter.paragraphs.push(allParagraphs[i].text);
      cursor = sliceEnd;
    }
    if (chapter) sections.push(chapter);
  }

  if (sections.length === 0) {
    let current: BookSection | null = null;
    let virtualIdx = 0;
    for (const { text } of allParagraphs) {
      const single = text.length < 120 && !text.includes(". ") && looksLikeHeading(text);
      if (single) {
        current = { level: 1, title: text, paragraphs: [] };
        sections.push(current);
        continue;
      }
      if (!current) {
        virtualIdx++;
        current = { level: 1, title: `Часть ${virtualIdx}`, paragraphs: [] };
        sections.push(current);
      }
      current.paragraphs.push(text);
    }
  }

  await doc.destroy();

  return {
    metadata: { title, author, language, warnings },
    sections: sections.filter((s) => s.paragraphs.length > 0),
    rawCharCount: totalChars,
  };
}

export const pdfParser: BookParser = { ext: "pdf", parse: parsePdf };
