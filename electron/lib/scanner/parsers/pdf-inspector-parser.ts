/**
 * Адаптер @firecrawl/pdf-inspector → ParseResult.
 *
 * pdf-inspector возвращает чистый markdown с классификацией layout. Мы
 * конвертируем его в нашу структуру `BookSection[]` (level / title /
 * paragraphs), сохраняя:
 *   - заголовки (H1/H2/H3 → level 1/2/3)
 *   - параграфы (разделённые пустой строкой)
 *   - таблицы как параграфы (markdown pipe-table сохраняется как есть —
 *     LLM-крайстализатор её прекрасно ест и распознаёт)
 *   - code fences ```...``` как один параграф
 *
 * Зачем не использовать `marked` (уже есть в зависимостях): нам нужна
 * только группировка по заголовкам, а не полный AST. Своя простая логика
 * быстрее и не тащит парсер на 100 KB.
 */
import { promises as fs } from "fs";
import * as path from "path";
import {
  cleanParagraph,
  type BookSection,
  type ParseOptions,
  type ParseResult,
} from "./types.js";
import {
  loadPdfInspector,
  getPdfInspectorLoadError,
  type PdfInspectorResult,
} from "./pdf-inspector-bridge.js";
import { isLowValueBookTitle, pickBestBookTitle } from "../../library/title-heuristics.js";

const MAX_PDF_FILE_BYTES = 200 * 1024 * 1024;

export interface InspectorParseOutcome {
  /**
   * "ok" — pdf-inspector отработал, есть результат.
   * "skipped" — модуль недоступен (старая Win/нет binary) либо файл слишком большой.
   * "scanned" — pdf-inspector сообщил, что страницы нужно OCR'ить.
   *             Caller должен пойти в OCR-путь, не пытаться использовать markdown.
   * "fallback" — pdf-inspector упал на этом конкретном файле (corrupt PDF и т.п.).
   */
  status: "ok" | "skipped" | "scanned" | "fallback";
  result?: ParseResult;
  /** Сырое решение от inspector — для аудита и smart-routing в caller'е. */
  classification?: {
    pdfType: PdfInspectorResult["pdfType"];
    pageCount: number;
    pagesNeedingOcr: number[];
    confidence: number;
  };
  /** Текст причины, если status !== "ok" — попадёт в warnings. */
  reason?: string;
  /** Сколько ms заняла классификация + processPdf (для метрик). */
  durationMs?: number;
}

/**
 * Попытаться распарсить PDF через pdf-inspector. Не throws — возвращает
 * статус, по которому caller решает что делать дальше.
 */
export async function tryParsePdfWithInspector(
  filePath: string,
  opts: ParseOptions = {},
): Promise<InspectorParseOutcome> {
  const inspector = await loadPdfInspector();
  if (!inspector) {
    return {
      status: "skipped",
      reason: `pdf-inspector unavailable (${getPdfInspectorLoadError() ?? "not loaded"})`,
    };
  }

  let stat: import("fs").Stats;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    return {
      status: "fallback",
      reason: `stat failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (stat.size > MAX_PDF_FILE_BYTES) {
    return {
      status: "skipped",
      reason: `file too large for in-memory inspector (${(stat.size / 1024 / 1024).toFixed(1)} MB > 200 MB)`,
    };
  }

  /* AbortSignal: pdf-inspector синхронный, поэтому single check перед
     загрузкой буфера. Дальнейшая обработка (NAPI call) обычно <5s даже
     на крупных книгах — недостаточно долго для повторной проверки. */
  if (opts.signal?.aborted) {
    return { status: "fallback", reason: "aborted before inspector call" };
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (err) {
    return {
      status: "fallback",
      reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const t0 = Date.now();

  let classification: ReturnType<typeof inspector.classifyPdf>;
  try {
    classification = inspector.classifyPdf(buf);
  } catch (err) {
    return {
      status: "fallback",
      reason: `classifyPdf threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t0,
    };
  }

  /* Scanned/ImageBased — текста в PDF почти нет. processPdf вернёт
     пустой markdown. Caller (parsePdfMain) запустит OCR-путь напрямую,
     минуя pdfjs полностью. Это и есть smart-routing выигрыш. */
  if (classification.pdfType === "Scanned" || classification.pdfType === "ImageBased") {
    return {
      status: "scanned",
      classification: {
        pdfType: classification.pdfType,
        pageCount: classification.pageCount,
        pagesNeedingOcr: classification.pagesNeedingOcr,
        confidence: classification.confidence,
      },
      reason: `inspector classified as ${classification.pdfType} (${classification.pagesNeedingOcr.length}/${classification.pageCount} pages need OCR, conf=${classification.confidence.toFixed(2)})`,
      durationMs: Date.now() - t0,
    };
  }

  let processed: PdfInspectorResult;
  try {
    processed = inspector.processPdf(buf);
  } catch (err) {
    return {
      status: "fallback",
      reason: `processPdf threw: ${err instanceof Error ? err.message : String(err)}`,
      classification: {
        pdfType: classification.pdfType,
        pageCount: classification.pageCount,
        pagesNeedingOcr: classification.pagesNeedingOcr,
        confidence: classification.confidence,
      },
      durationMs: Date.now() - t0,
    };
  }

  const md = processed.markdown ?? "";
  if (md.trim().length === 0) {
    /* Пустой markdown при не-Scanned типе — крайне редко, но бывает на
       PDF с рендером через outline без текстовых run'ов. Не доверяем
       результату — пусть pdfjs попробует. */
    return {
      status: "fallback",
      reason: "inspector returned empty markdown for non-scanned PDF",
      classification: {
        pdfType: classification.pdfType,
        pageCount: classification.pageCount,
        pagesNeedingOcr: classification.pagesNeedingOcr,
        confidence: classification.confidence,
      },
      durationMs: Date.now() - t0,
    };
  }

  const sections = parseMarkdownToSections(md);
  if (sections.length === 0) {
    return {
      status: "fallback",
      reason: "markdown parsed but yielded 0 sections",
      classification: {
        pdfType: classification.pdfType,
        pageCount: classification.pageCount,
        pagesNeedingOcr: classification.pagesNeedingOcr,
        confidence: classification.confidence,
      },
      durationMs: Date.now() - t0,
    };
  }

  const totalChars = sections.reduce(
    (sum, sec) => sum + sec.paragraphs.reduce((s, p) => s + p.length, 0),
    0,
  );

  /* Title resolution: inspector → first H1 in markdown → filename.
     Reuse существующих эвристик (isLowValueBookTitle, pickBestBookTitle)
     чтобы не отличаться от pdfjs-парсера. */
  const inspectorTitle =
    typeof processed.title === "string" && processed.title.trim()
      ? processed.title.trim()
      : undefined;
  const headingTitle = sections.find((s) => s.level === 1)?.title;
  const filenameTitle = path.basename(filePath, path.extname(filePath));
  const title =
    pickBestBookTitle(
      inspectorTitle && !isLowValueBookTitle(inspectorTitle) ? inspectorTitle : undefined,
      headingTitle && !isLowValueBookTitle(headingTitle) ? headingTitle : undefined,
      filenameTitle,
    ) || filenameTitle;

  const warnings: string[] = [];
  warnings.push(
    `pdf-inspector: ${classification.pdfType} (${classification.pageCount} pages, ${processed.processingTimeMs}ms native)`,
  );
  if (processed.isComplexLayout) {
    warnings.push(
      `pdf-inspector: complex layout — ${processed.pagesWithTables.length} table page(s), ${processed.pagesWithColumns.length} column page(s)`,
    );
  }
  if (processed.hasEncodingIssues) {
    warnings.push(`pdf-inspector: PDF has encoding issues (some characters may be garbled)`);
  }
  if (classification.pdfType === "Mixed" && classification.pagesNeedingOcr.length > 0) {
    warnings.push(
      `pdf-inspector: ${classification.pagesNeedingOcr.length} page(s) flagged for OCR but extracted via text layer`,
    );
  }

  return {
    status: "ok",
    result: {
      metadata: { title, warnings },
      sections,
      rawCharCount: totalChars,
    },
    classification: {
      pdfType: classification.pdfType,
      pageCount: classification.pageCount,
      pagesNeedingOcr: classification.pagesNeedingOcr,
      confidence: classification.confidence,
    },
    durationMs: Date.now() - t0,
  };
}

/**
 * Простой парсер markdown → BookSection[].
 *
 * Правила:
 *   - `# / ## / ### / #### / ##### / ######` → новый раздел.
 *     level 1 для #/##, level 2 для ###/####, level 3 для #####/######.
 *     (PDF-инспектор склонен к over-nesting, поэтому сжимаем.)
 *   - Параграфы разделены пустыми строками.
 *   - Markdown-таблицы (строки с `|`) объединяются в один параграф —
 *     LLM-кристаллизатор корректно их интерпретирует.
 *   - Code fences ```...``` рассматриваются как один параграф.
 *   - Если до первого heading'а есть текст — он попадает в неявную
 *     `Часть 1` секцию (как в pdfjs-парсере).
 */
export function parseMarkdownToSections(md: string): BookSection[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let buffer: string[] = [];
  let inCodeFence = false;
  let virtualIdx = 0;

  const flushParagraph = (): void => {
    if (buffer.length === 0) return;
    const text = cleanParagraph(buffer.join("\n"));
    buffer = [];
    if (!text) return;
    if (!current) {
      virtualIdx++;
      current = { level: 1, title: virtualIdx === 1 ? "Введение" : `Часть ${virtualIdx}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(text);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    /* Code fences — копим как единый блок без интерпретации заголовков. */
    if (/^\s*```/u.test(line)) {
      buffer.push(line);
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      buffer.push(line);
      continue;
    }

    /* Heading: 1-6 hashes followed by space. */
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (headingMatch) {
      flushParagraph();
      const hashCount = headingMatch[1]!.length;
      const heading = headingMatch[2]!.trim();
      if (!heading) continue;
      /* Сжимаем 1-6 в наши 1-3 уровня:
         #/## → 1; ###/#### → 2; #####/###### → 3. */
      const level: BookSection["level"] = hashCount <= 2 ? 1 : hashCount <= 4 ? 2 : 3;
      current = { level, title: heading, paragraphs: [] };
      sections.push(current);
      continue;
    }

    /* Empty line — flush буфер как параграф. */
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    buffer.push(line);
  }

  flushParagraph();

  /* Финальная фильтрация — секции без параграфов и без понятного title
     не несут пользы для chunker'а. */
  return sections.filter((s) => s.paragraphs.length > 0 || s.title.length > 0);
}
