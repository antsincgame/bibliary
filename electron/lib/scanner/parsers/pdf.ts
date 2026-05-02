import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseOptions, type ParseResult, type BookSection } from "./types.js";
import { isOcrSupported, rasterisePdfPages } from "../ocr/index.js";
import { parsePdfInWorker, isWorkerPdfEnabled } from "./pdf-worker-host.js";
import { getPdfjsStandardFontDataUrl } from "../pdfjs-node.js";
import { isLowValueBookTitle, pickBestBookTitle } from "../../library/title-heuristics.js";
import { tryParsePdfWithInspector } from "./pdf-inspector-parser.js";
import { tryParsePdfWithEdgeParse } from "./edgeparse-parser.js";
import { runExtractionCascade } from "../extractors/cascade-runner.js";
import { createPdfPageExtractor } from "./pdf-page-extractor.js";

/**
 * Жёсткие потолки памяти для PDF parser — защита от OOM на огромных книгах.
 * Применяются до того как `maxBookChars` из prefs (он работает уже после
 * парсинга для warning'а). Если файл/текст превышает эти лимиты — парсер
 * отказывается от работы или прерывает её и возвращает partial результат
 * с warning, чтобы вызывающий ingest pipeline увидел причину.
 *
 * Источник цифр:
 *   - 200 MB файл — pdfjs raster decode может занять до 3x = 600 MB пиковой
 *     RAM, что уже опасно для 8 GB машин. Большинство книг в OSP-каталогах
 *     укладываются в 50 MB; 200 MB — это уже отсканированные тома или
 *     publisher PDF с embedded fonts на сотни мегабайт.
 *   - 50 M chars текста = ~100 MB UTF-8 в `allParagraphs[]`. Даже книга
 *     "Война и мир" — ~3 M chars, так что 50 M — это худший случай для
 *     корпуса (учебник/энциклопедия), за пределами которого запускать
 *     ingest бессмысленно (LLM context всё равно не охватит).
 */
const MAX_PDF_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PDF_TEXT_CHARS = 50_000_000;

function isLikelyPdfTitleNoise(line: string): boolean {
  const normalized = line
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("от авторов")) return true;
  if (/^[a-zа-я0-9._-]+\.(jpg|jpeg|png|webp|tif|tiff|bmp)$/iu.test(normalized)) return true;
  if (/^(стр|page)\s*\.?\s*\d+$/iu.test(normalized)) return true;
  if (/^\(?\d{4}\)?$/u.test(normalized)) return true;
  if (/^(isbn|удк|keywords?|ключевые слова|reviewers?|рецензенты)\b/iu.test(normalized)) return true;
  if (/^(министерство|the ministry|санкт\s*[-–—]?\s*петербург|st\.?\s*[-–—]?\s*petersburg|издательство|publishing house|polytechnic|университет|university|институт|institute|higher school|faculty|монография|monograph|©)\b/iu.test(normalized)) {
    return true;
  }
  return false;
}

function isLikelyPdfTitleLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4 || trimmed.length > 100) return false;
  if (isLikelyPdfTitleNoise(trimmed)) return false;
  if (/^[A-ZА-ЯЁ]\.[A-ZА-ЯЁ][\p{L}. -]*$/u.test(trimmed)) return false;
  if (/^[A-ZА-ЯЁ][a-zа-яё-]+(?:\s+[A-ZА-ЯЁ][a-zа-яё-]+){0,2}$/u.test(trimmed) && trimmed.split(/\s+/).length <= 3) {
    return false;
  }
  return looksLikeHeading(trimmed) || /^[\p{L}\p{N}][\p{L}\p{N}\s()\-–—,.:/+]+$/u.test(trimmed);
}

function normalizePdfTitleBlock(lines: string[]): string {
  return lines
    .map((line) => line.replace(/\s*-\s*$/u, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function guessPdfTitleFromParagraphs(paragraphs: Array<{ page: number; text: string }>): string | null {
  const scope = paragraphs
    .filter((p) => p.page <= 2)
    .slice(0, 60)
    .map((p) => cleanParagraph(p.text))
    .filter((line) => line.length > 0);

  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of scope) {
    if (isLikelyPdfTitleLine(line)) {
      if (current.length >= 4) {
        blocks.push(current);
        current = [];
      }
      current.push(line);
      continue;
    }
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);

  let best: { title: string; score: number } | null = null;
  for (const block of blocks) {
    const title = pickBestBookTitle(normalizePdfTitleBlock(block));
    if (!title || isLowValueBookTitle(title)) continue;
    if (isLikelyPdfTitleNoise(title)) continue;
    if (title.split(/\s+/).length > 12) continue;
    if (title.length > 90) continue;
    const score = title.length + block.length * 24;
    if (!best || score > best.score) {
      best = { title, score };
    }
  }
  return best?.title ?? null;
}

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
/**
 * Public PDF parser. Dispatcher между главным потоком и worker_thread'ом.
 *
 * Worker используется только если:
 *   - ENV `BIBLIARY_PARSE_WORKERS=1` (опт-ин, защита R4 из плана)
 *   - opts.ocrEnabled !== true (OCR требует нативные модули, надёжнее в main)
 *
 * В worker'е:
 *   - true SIGKILL зависшего pdfjs через `worker.terminate()`
 *   - изоляция OOM: краш worker'а не валит main process
 *   - state pdfjs не накапливается между книгами (свежий module load)
 *
 * Если worker недоступен (тесты через tsx, сборка не сделана) — silently
 * fallback на main thread без потери функциональности.
 */
async function parsePdf(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  if (isWorkerPdfEnabled() && opts.ocrEnabled !== true) {
    try {
      return await parsePdfInWorker(filePath, opts);
    } catch (err) {
      /* Worker не загрузился (например, dev-режим через tsx) — graceful
         fallback. Худшее что может случиться — медленнее на одной книге. */
      const msg = err instanceof Error ? err.message : String(err);
      if (/worker not available|cannot find module/i.test(msg)) {
        return parsePdfMain(filePath, opts);
      }
      throw err;
    }
  }
  return parsePdfMain(filePath, opts);
}

/**
 * Main-thread implementation. Используется когда worker отключён,
 * OCR enabled, или worker не загрузился. Также этот же код вызывается
 * ИЗ worker'а — поэтому он чистый, без AbortSignal-привязки к main.
 *
 * Пайплайн (Apr 2026) — трёхуровневый каскад:
 *   0. OOM-guard по размеру файла.
 *   1. pdf-inspector (Rust/lopdf, ~200ms) — primary:
 *      таблицы, колонки, markdown с layout.
 *   2. edgeparse (Rust/XY-Cut++, ~10s) — secondary:
 *      reading order, table border/cluster detection.
 *   3. pdfjs-dist (JS, emergency) — legacy fallback для
 *      encrypted/corrupt PDF и edge cases.
 *   OCR: если Stage 1 сообщил "Scanned"/"ImageBased" — стадии 2-3
 *   пропускаются, идём прямо в OCR через rasterisePdfPages.
 */
export async function parsePdfMain(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  // OOM-guard #1: отказ до чтения, если файл превышает MAX_PDF_FILE_BYTES.
  // Это дёшево (только stat) и предотвращает 600+ MB пиковой RAM на raster decode.
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PDF_FILE_BYTES) {
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    const limitMb = (MAX_PDF_FILE_BYTES / 1024 / 1024).toFixed(0);
    return {
      metadata: {
        title: path.basename(filePath, path.extname(filePath)),
        warnings: [`PDF too large (${sizeMb} MB > ${limitMb} MB hard limit) — refused to parse`],
      },
      sections: [],
      rawCharCount: 0,
    };
  }

  /* ── Stage 0 — pdf-inspector primary path (Rust/lopdf, ~200ms) ── */
  const inspectorEnabled = process.env.BIBLIARY_PDF_INSPECTOR !== "0";
  let inspectorScanWarning: string | null = null;
  let needEdgeparseFallback = false;
  if (inspectorEnabled) {
    const outcome = await tryParsePdfWithInspector(filePath, opts);
    if (outcome.status === "ok" && outcome.result) {
      return outcome.result;
    }
    if (outcome.status === "scanned") {
      inspectorScanWarning = outcome.reason ?? "pdf-inspector: scanned PDF, OCR required";
    } else if (outcome.status === "fallback" || outcome.status === "skipped") {
      inspectorScanWarning = outcome.reason
        ? `pdf-inspector ${outcome.status}: ${outcome.reason}`
        : null;
      needEdgeparseFallback = true;
    }
  } else {
    needEdgeparseFallback = true;
  }

  /* ── Stage 1 — edgeparse secondary path (Rust/XY-Cut++, ~10s) ── */
  const edgeparseEnabled = process.env.BIBLIARY_EDGEPARSE !== "0";
  let edgeparseWarning: string | null = null;
  if (needEdgeparseFallback && edgeparseEnabled) {
    const epOutcome = await tryParsePdfWithEdgeParse(filePath, opts);
    if (epOutcome.status === "ok" && epOutcome.result) {
      if (inspectorScanWarning) {
        epOutcome.result.metadata.warnings = [
          inspectorScanWarning,
          ...(epOutcome.result.metadata.warnings ?? []),
        ];
      }
      return epOutcome.result;
    }
    if (epOutcome.reason) {
      edgeparseWarning = `edgeparse ${epOutcome.status}: ${epOutcome.reason}`;
    }
  }

  /* ── Stage 2 — pdfjs-dist emergency fallback (JS, slowest) ── */

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const buf = await fs.readFile(filePath);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: getPdfjsStandardFontDataUrl(),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
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
  const author = typeof info.Author === "string" && info.Author.trim() ? String(info.Author) : undefined;
  const language = typeof info.Language === "string" ? String(info.Language) : undefined;

  const year = (() => {
    for (const key of ["ModDate", "CreationDate"]) {
      const raw = info[key];
      if (typeof raw === "string") {
        const m = raw.match(/(\d{4})/);
        if (m) { const y = Number(m[1]); if (y >= 1800 && y <= 2100) return y; }
      }
    }
    return undefined;
  })();

  const identifier = (() => {
    for (const key of ["ISBN", "isbn", "Subject", "Keywords"]) {
      const raw = info[key];
      if (typeof raw === "string") {
        const m = raw.match(/((?:978|979)[\d-]{10,})/);
        if (m) return m[1].replace(/[-\s]/g, "");
        const m10 = raw.match(/(\d{9}[\dXx])/);
        if (m10) return m10[1];
      }
    }
    return undefined;
  })();

  const publisher = typeof info.Publisher === "string" && info.Publisher.trim()
    ? info.Publisher.trim() : undefined;

  let outline: Awaited<ReturnType<typeof doc.getOutline>> | null = null;
  try {
    outline = await doc.getOutline();
  } catch {
    /* noop */
  }

  const allParagraphs: Array<{ page: number; text: string }> = [];
  let totalChars = 0;
  let pagesParsed = 0;
  let truncatedAtPage: number | null = null;

  /* Если pdf-inspector сообщил, что PDF — скан/image-based, мы УЖЕ знаем,
     что page.getTextContent() даст 0 параграфов. Пропускаем дорогой цикл
     на N сотен страниц и идём прямо в OCR-блок. Экономия — минуты на
     больших томах с 500+ страницами. */
  const skipTextLayer = inspectorScanWarning !== null && /scanned|imagebased/i.test(inspectorScanWarning);
  if (skipTextLayer) {
    warnings.push(inspectorScanWarning!);
    pagesParsed = doc.numPages;
  }

  /* AUDIT MED-6: цикл по страницам мог идти минутами на 1000-страничном
     PDF и игнорировал opts.signal — cancel ingest'а не прерывал парсинг.
     Проверяем перед каждой страницей: дешёво, но мгновенно отвечает. */
  for (let pageNum = 1; !skipTextLayer && pageNum <= doc.numPages; pageNum++) {
    if (opts.signal?.aborted) {
      await doc.destroy().catch((err) => console.error("[pdf/parsePdfText] destroy Error:", err));
      throw new Error(`pdf parse aborted at page ${pageNum}/${doc.numPages}`);
    }
    /* OOM-guard #2: накопленный текст превысил MAX_PDF_TEXT_CHARS.
       Прерываем чтение и возвращаем то, что уже распарсили — partial
       result лучше чем краш всего ingest'а. doc.destroy() в конце
       освободит pdfjs internal structures. */
    if (totalChars >= MAX_PDF_TEXT_CHARS) {
      truncatedAtPage = pageNum;
      break;
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
    pagesParsed = pageNum;
  }

  if (truncatedAtPage !== null) {
    const limitMchars = (MAX_PDF_TEXT_CHARS / 1_000_000).toFixed(0);
    warnings.push(
      `PDF truncated at page ${truncatedAtPage}/${doc.numPages} ` +
      `(parsed ${pagesParsed}, ~${limitMchars}M chars hard limit reached)`,
    );
  }

  if (inspectorScanWarning !== null && !skipTextLayer) {
    warnings.push(inspectorScanWarning);
  }
  if (edgeparseWarning) {
    warnings.push(edgeparseWarning);
  }

  /* Имиджевая страница (или весь scanned PDF): запускаем Universal Cascade
     per-page. Tier 0 (text-layer) уже обработан выше через pdfjs textContent;
     поэтому extractor реализует только Tier 1 (system-ocr) и Tier 2 (vision-llm).
     Cascade Runner сам выбирает дешёвый Tier и делает fallback при quality < 0.5.
     Vision-OCR обёрнут в scheduler heavy lane (см. Иt 8В MAIN.1.1) — даже
     при scanned PDF на 500 страниц heavy-очередь не разнесёт VRAM. */
  if (allParagraphs.length === 0) {
    const visionConfigured = Boolean(opts.visionModelKey);
    if (opts.ocrEnabled && (isOcrSupported() || visionConfigured)) {
      let ocrAppliedPages = 0;
      let visionAppliedPages = 0;
      let failedPages = 0;
      const pageWarnings: string[] = [];
      try {
        for await (const page of rasterisePdfPages(filePath, {
          signal: opts.signal,
          dpi: opts.ocrPdfDpi,
        })) {
          const extractor = createPdfPageExtractor(page.pngBuffer, page.pageIndex);
          const cascade = await runExtractionCascade(extractor, filePath, {
            languages: opts.ocrLanguages,
            signal: opts.signal,
            visionModelKey: opts.visionModelKey,
          });
          const txt = cascade.attempt?.text.trim() ?? "";
          if (!txt) {
            failedPages++;
            for (const w of cascade.attempt?.warnings ?? []) pageWarnings.push(w);
            continue;
          }
          const paragraphs = txt
            .split(/\n{2,}/)
            .map((p) => cleanParagraph(p))
            .filter((p) => p.length > 0);
          for (const para of paragraphs) {
            allParagraphs.push({ page: page.pageIndex + 1, text: para });
            totalChars += para.length;
          }
          ocrAppliedPages++;
          if (cascade.attempt?.engine === "vision-llm") visionAppliedPages++;
        }
      } catch (err) {
        warnings.push(`OCR failed: ${(err as Error).message.slice(0, 200)}`);
      }

      if (ocrAppliedPages > 0) {
        const visionTag = visionAppliedPages > 0 ? `, ${visionAppliedPages} via vision-LLM` : "";
        warnings.push(
          `OCR applied to ${ocrAppliedPages} page(s)${visionTag} -- text reconstructed from images`,
        );
      } else if (failedPages > 0) {
        warnings.push("OCR ran but produced no text (poor image quality?)");
      }
      /* Не флудим warnings всеми per-page failures, держим первые 3 для
         observability — этого хватает для диагностики проблемного scan. */
      const uniquePageWarnings = Array.from(new Set(pageWarnings)).slice(0, 3);
      for (const w of uniquePageWarnings) warnings.push(w);
      if (pageWarnings.length > uniquePageWarnings.length) {
        warnings.push(`(+ ${pageWarnings.length - uniquePageWarnings.length} more cascade warnings suppressed)`);
      }
    } else {
      const reason = opts.ocrEnabled
        ? "OCR not supported on this OS (requires Windows or macOS) and no vision-LLM model configured"
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

  const contentTitle = guessPdfTitleFromParagraphs(allParagraphs);
  const title = pickBestBookTitle(
    typeof info.Title === "string" ? info.Title : undefined,
    contentTitle,
    path.basename(filePath, path.extname(filePath)),
  ) || path.basename(filePath, path.extname(filePath));

  await doc.destroy();

  return {
    metadata: { title, author, language, identifier, year, publisher, warnings },
    sections: sections.filter((s) => s.paragraphs.length > 0),
    rawCharCount: totalChars,
  };
}

export const pdfParser: BookParser = { ext: "pdf", parse: parsePdf };
