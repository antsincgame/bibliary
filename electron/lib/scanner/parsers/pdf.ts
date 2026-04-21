import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseOptions, type ParseResult, type BookSection } from "./types.js";
import { isOcrSupported, rasterisePdfPages, recognizeImageBuffer } from "../ocr/index.js";

/**
 * PDF parser based on pdfjs-dist (legacy build).
 *
 * Extracts text by page, merges into paragraphs heuristically (based on
 * line gaps), reconstructs chapters from TOC outline.
 *
 * If `opts.ocrEnabled === true` and the PDF yields no text (scanned/image
 * PDF) — falls back to OS-native OCR via @napi-rs/system-ocr by rasterising
 * pages with @napi-rs/canvas. OCR is opt-in: heavy operation.
 */
async function parsePdf(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
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
  /* AUDIT MED-6: цикл по страницам мог идти минутами на 1000-страничном
     PDF и игнорировал opts.signal — cancel ingest'а не прерывал парсинг.
     Проверяем перед каждой страницей: дешёво, но мгновенно отвечает. */
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    if (opts.signal?.aborted) {
      await doc.destroy().catch(() => undefined);
      throw new Error(`pdf parse aborted at page ${pageNum}/${doc.numPages}`);
    }
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

  let ocrAppliedPages = 0;
  if (allParagraphs.length === 0) {
    if (opts.ocrEnabled && isOcrSupported()) {
      try {
        for await (const page of rasterisePdfPages(filePath, {
          signal: opts.signal,
          dpi: opts.ocrPdfDpi,
        })) {
          const result = await recognizeImageBuffer(
            page.pngBuffer,
            page.pageIndex,
            opts.ocrLanguages ?? [],
            opts.ocrAccuracy ?? "accurate",
            opts.signal,
          );
          const txt = result.text.trim();
          if (!txt) continue;
          const paragraphs = txt
            .split(/\n{2,}/)
            .map((p) => cleanParagraph(p))
            .filter((p) => p.length > 0);
          for (const para of paragraphs) {
            allParagraphs.push({ page: page.pageIndex + 1, text: para });
            totalChars += para.length;
          }
          ocrAppliedPages++;
        }
        if (ocrAppliedPages > 0) {
          warnings.push(`OCR applied to ${ocrAppliedPages} page(s) -- text reconstructed from images`);
        } else {
          warnings.push("OCR ran but produced no text (poor image quality?)");
        }
      } catch (err) {
        warnings.push(`OCR failed: ${(err as Error).message.slice(0, 200)}`);
      }
    } else {
      const reason = opts.ocrEnabled
        ? "OCR not supported on this OS (requires Windows or macOS)"
        : "OCR not enabled (turn it on in Settings to recognise scanned PDFs)";
      warnings.push(`no text extracted (likely a scanned/image PDF — ${reason})`);
    }
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
      const matchIdx = allParagraphs.findIndex((p, idx) =>
        idx >= cursor && typeof p?.text === "string" &&
        p.text.toLowerCase().includes(heading.toLowerCase().slice(0, 40)),
      );
      if (chapter) sections.push(chapter);
      chapter = { level: 1, title: heading, paragraphs: [] };
      const sliceStart = matchIdx >= 0 ? matchIdx : cursor;
      /* sliceEnd MUST be an integer -- the previous version used
         `allParagraphs.length / outline.length` which yields a float
         (e.g. 47.3). The for-loop then read allParagraphs[47] when length
         was 47, producing undefined -> "Cannot read properties of
         undefined (reading 'text')" on the .text access below. */
      const avgChunk = Math.max(20, Math.ceil(allParagraphs.length / outline.length));
      const sliceEnd = (chapterIdx < outline.length)
        ? Math.min(sliceStart + avgChunk, allParagraphs.length)
        : allParagraphs.length;
      for (let i = sliceStart; i < sliceEnd; i++) {
        const p = allParagraphs[i];
        if (p && typeof p.text === "string") chapter.paragraphs.push(p.text);
      }
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
