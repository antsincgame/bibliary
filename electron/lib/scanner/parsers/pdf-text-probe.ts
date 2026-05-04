/**
 * Лёгкая проверка PDF на наличие text-layer'а — для preflight.
 *
 * Использует существующий `@firecrawl/pdf-inspector`, который классифицирует
 * PDF как TextBased/Scanned/ImageBased/Mixed. Для preflight достаточно
 * грубого вердикта «text есть / нет».
 *
 * ВАЖНО: pdf-inspector грузит весь PDF в память. Для preflight это
 * приемлемо, но мы ограничиваемся файлами < 200 MB — дальше скан становится
 * заметно медленным (по 100-300 мс на крупный файл) и может ударить по
 * памяти при массовом импорте. Файлы крупнее метим как unknown.
 */

import { promises as fs } from "fs";
import { loadPdfInspector } from "./pdf-inspector-bridge.js";

export interface PdfProbeResult {
  /** Файл — валидный PDF (либо успешно классифицирован, либо хотя бы magic bytes). */
  valid: boolean;
  /** Имеет полный или частичный text-layer (TextBased или Mixed). */
  hasTextLayer: boolean;
  /** Грубая категория из pdf-inspector. */
  classification: "TextBased" | "Scanned" | "ImageBased" | "Mixed" | "unknown";
  pageCount?: number;
  /** Если probe не мог запуститься — короткое описание причины. */
  parseError?: string;
}

const MAX_PDF_PROBE_BYTES = 200 * 1024 * 1024;

export async function probePdfTextLayer(filePath: string): Promise<PdfProbeResult> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PDF_PROBE_BYTES) {
    return {
      valid: true,
      hasTextLayer: false,
      classification: "unknown",
      parseError: `pdf too large for preflight (${(stat.size / 1024 / 1024).toFixed(0)} MB > 200 MB cap)`,
    };
  }
  if (stat.size < 16) {
    return { valid: false, hasTextLayer: false, classification: "unknown", parseError: "file too small" };
  }

  /* Magic bytes %PDF — проверяем чтобы отсеять явно битые/не-PDF. */
  const head = Buffer.alloc(8);
  const fh = await fs.open(filePath, "r");
  try {
    await fh.read(head, 0, 8, 0);
  } finally {
    await fh.close();
  }
  if (head.toString("ascii", 0, 4) !== "%PDF") {
    return { valid: false, hasTextLayer: false, classification: "unknown", parseError: "missing %PDF magic" };
  }

  const inspector = await loadPdfInspector();
  if (!inspector) {
    return {
      valid: true,
      hasTextLayer: false,
      classification: "unknown",
      parseError: "pdf-inspector module unavailable",
    };
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (err) {
    return {
      valid: true,
      hasTextLayer: false,
      classification: "unknown",
      parseError: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const cls = inspector.classifyPdf(buf);
    const hasTextLayer = cls.pdfType === "TextBased" || cls.pdfType === "Mixed";
    return {
      valid: true,
      hasTextLayer,
      classification: cls.pdfType,
      pageCount: cls.pageCount,
    };
  } catch (err) {
    return {
      valid: true,
      hasTextLayer: false,
      classification: "unknown",
      parseError: `classifyPdf failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
