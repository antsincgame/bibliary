import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseOptions, type ParseResult, type BookSection } from "./types.js";
import { isOcrSupported, recognizeImageBuffer } from "../ocr/index.js";
import { recognizeWithVisionLlm } from "../../llm/vision-ocr.js";
import { getDjvuInstallHint, getDjvuPageCount, runDdjvu, runDjvutxt } from "./djvu-cli.js";
import { imageBufferToPng } from "../../native/sharp-loader.js";

const MAX_DJVU_FILE_BYTES = 500 * 1024 * 1024;

async function parseDjvu(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const stat = await fs.stat(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const warnings: string[] = [];

  if (stat.size > MAX_DJVU_FILE_BYTES) {
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    return {
      metadata: { title: baseName, warnings: [`DJVU too large (${sizeMb} MB) — refused`] },
      sections: [],
      rawCharCount: 0,
    };
  }

  let text = "";
  try {
    text = await runDjvutxt(filePath, opts.signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`djvutxt unavailable or failed: ${msg.slice(0, 140)}`);
    warnings.push(getDjvuInstallHint());
  }

  if (text.length > 100) {
    const sections = textToSections(text);
    return {
      metadata: { title: guessTitleFromText(text) || baseName, warnings },
      sections,
      rawCharCount: text.length,
    };
  }

  const provider = opts.djvuOcrProvider ?? "system";
  /* DJVU — это всегда растровый формат; без текстового слоя OCR — единственный
     вариант. Блокируем только если явно указан provider=none. */
  if (provider === "none") {
    warnings.push("DJVU has no usable text layer and OCR is disabled (provider=none)");
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  if (provider === "system" && !isOcrSupported()) {
    warnings.push("System OCR for DJVU is available only on Windows and macOS");
    warnings.push(getDjvuInstallHint());
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  return ocrDjvuPages(filePath, baseName, provider, opts, warnings);
}

async function ocrDjvuPages(
  filePath: string,
  baseName: string,
  provider: "system" | "vision-llm",
  opts: ParseOptions,
  warnings: string[],
): Promise<ParseResult> {
  let pageCount = 1;
  try {
    pageCount = await getDjvuPageCount(filePath, opts.signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`djvused page count failed: ${msg.slice(0, 120)}`);
    warnings.push(getDjvuInstallHint());
  }

  const dpi = opts.djvuRenderDpi ?? opts.ocrPdfDpi ?? 200;
  const paragraphs: Array<{ page: number; text: string }> = [];
  let totalChars = 0;
  let ocrPages = 0;

  for (let page = 0; page < pageCount; page++) {
    if (opts.signal?.aborted) throw new Error("djvu OCR aborted");
    try {
      const imageBuffer = await runDdjvu(filePath, page, dpi, opts.signal);
      const pngBuffer = await imageBufferToPng(imageBuffer);
      const result = provider === "vision-llm"
        ? await recognizeWithVisionLlm(pngBuffer, {
          languages: opts.ocrLanguages ?? [],
          signal: opts.signal,
          mimeType: "image/png",
        })
        : await recognizeImageBuffer(
          new Uint8Array(pngBuffer.buffer, pngBuffer.byteOffset, pngBuffer.byteLength),
          page,
          opts.ocrLanguages ?? [],
          opts.ocrAccuracy ?? "accurate",
          opts.signal,
        );
      const text = result.text.trim();
      if (!text) continue;
      const blocks = text
        .split(/\n{2,}/)
        .map((line) => cleanParagraph(line))
        .filter((line) => line.length > 0);
      for (const block of blocks) {
        paragraphs.push({ page: page + 1, text: block });
        totalChars += block.length;
      }
      ocrPages++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`DJVU OCR failed on page ${page + 1}: ${msg.slice(0, 120)}`);
    }
  }

  if (ocrPages > 0) warnings.push(`DJVU OCR applied to ${ocrPages}/${pageCount} page(s) using ${provider}`);
  if (ocrPages === 0) warnings.push("DJVU OCR produced no text. Check djvulibre binaries and OCR settings.");
  if (ocrPages === 0) warnings.push(getDjvuInstallHint());

  const sections = paragraphsToSections(paragraphs);
  return {
    metadata: { title: baseName, warnings },
    sections,
    rawCharCount: totalChars,
  };
}

function textToSections(text: string): BookSection[] {
  const blocks = text.split(/\n\s*\n/).map((b) => cleanParagraph(b)).filter(Boolean);
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let untitled = 0;
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length === 1 && looksLikeHeading(lines[0])) {
      current = { level: 1, title: lines[0].trim(), paragraphs: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      untitled++;
      current = { level: 1, title: `Section ${untitled}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(block.replace(/\n/g, " "));
  }
  return sections.filter((s) => s.paragraphs.length > 0);
}

function paragraphsToSections(paragraphs: Array<{ page: number; text: string }>): BookSection[] {
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let lastPage = -1;
  for (const { page, text } of paragraphs) {
    if (page !== lastPage) {
      current = { level: 1, title: `Page ${page}`, paragraphs: [] };
      sections.push(current);
      lastPage = page;
    }
    if (looksLikeHeading(text) && text.length < 100) {
      current = { level: 1, title: text, paragraphs: [] };
      sections.push(current);
      continue;
    }
    current!.paragraphs.push(text);
  }
  return sections.filter((s) => s.paragraphs.length > 0);
}

function guessTitleFromText(text: string): string | null {
  const firstLine = text.split("\n").find((l) => l.trim().length > 3);
  return firstLine && firstLine.trim().length < 120 ? firstLine.trim() : null;
}

export const djvuParser: BookParser = { ext: "djvu", parse: parseDjvu };
