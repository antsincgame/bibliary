/**
 * Адаптер edgeparse → ParseResult.
 *
 * Второй уровень каскада: если pdf-inspector отказал (scanned PDF — не в счёт,
 * т.к. нативный парсер текста не поможет), edgeparse пробует свой XY-Cut++
 * reading order и table detection. Если и он не справился — caller перейдёт
 * к pdfjs-dist (аварийный третий уровень).
 */
import * as path from "path";
import {
  type BookSection,
  type ParseOptions,
  type ParseResult,
} from "./types.js";
import { loadEdgeParse, getEdgeParseLoadError } from "./edgeparse-bridge.js";
import { parseMarkdownToSections } from "./pdf-inspector-parser.js";
import { isLowValueBookTitle, pickBestBookTitle } from "../../library/title-heuristics.js";

export interface EdgeParseOutcome {
  status: "ok" | "skipped" | "fallback";
  result?: ParseResult;
  reason?: string;
  durationMs?: number;
}

export async function tryParsePdfWithEdgeParse(
  filePath: string,
  _opts: ParseOptions = {},
): Promise<EdgeParseOutcome> {
  const edgeparse = await loadEdgeParse();
  if (!edgeparse) {
    return {
      status: "skipped",
      reason: `edgeparse unavailable (${getEdgeParseLoadError() ?? "not loaded"})`,
    };
  }

  if (_opts.signal?.aborted) {
    return { status: "fallback", reason: "aborted before edgeparse call" };
  }

  const t0 = Date.now();
  let markdown: string;
  try {
    markdown = edgeparse.convert(filePath, {
      format: "markdown",
      readingOrder: "xycut",
      tableMethod: "border",
      imageOutput: "none",
    });
  } catch (err) {
    return {
      status: "fallback",
      reason: `edgeparse.convert threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t0,
    };
  }

  if (!markdown || markdown.trim().length === 0) {
    return {
      status: "fallback",
      reason: "edgeparse returned empty markdown",
      durationMs: Date.now() - t0,
    };
  }

  const sections: BookSection[] = parseMarkdownToSections(markdown);
  if (sections.length === 0) {
    return {
      status: "fallback",
      reason: "edgeparse markdown parsed but yielded 0 sections",
      durationMs: Date.now() - t0,
    };
  }

  const totalChars = sections.reduce(
    (sum, sec) => sum + sec.paragraphs.reduce((s, p) => s + p.length, 0),
    0,
  );

  const headingTitle = sections.find((s) => s.level === 1)?.title;
  const filenameTitle = path.basename(filePath, path.extname(filePath));
  const title =
    pickBestBookTitle(
      headingTitle && !isLowValueBookTitle(headingTitle) ? headingTitle : undefined,
      filenameTitle,
    ) || filenameTitle;

  const durationMs = Date.now() - t0;

  const warnings: string[] = [];
  warnings.push(`edgeparse: XY-Cut++ (${(durationMs / 1000).toFixed(1)}s, ${totalChars} chars)`);

  return {
    status: "ok",
    result: {
      metadata: { title, warnings },
      sections,
      rawCharCount: totalChars,
    },
    durationMs,
  };
}
