/**
 * Тонкая безопасная обёртка над `@firecrawl/pdf-inspector`.
 *
 * Зачем отдельный модуль:
 *  - Загрузка нативного `.node` binary может упасть на старых Windows /
 *    в worker_thread / в окружении без MSVC redistributable. Мы не хотим,
 *    чтобы PDF-парсер целиком отказывался работать в этом случае.
 *  - В среде тестов (tsx) ESM-импорт `@firecrawl/pdf-inspector` иногда
 *    тянет dynamic require — здесь мы оборачиваем загрузку в try/catch
 *    с однократной мемоизацией результата.
 *  - Любой потребитель должен видеть либо рабочий API, либо `null`
 *    (никаких throw до момента непосредственного вызова функции).
 */

export interface PdfInspectorClassification {
  pdfType: "TextBased" | "Scanned" | "ImageBased" | "Mixed";
  pageCount: number;
  /** 0-indexed page numbers that need OCR. */
  pagesNeedingOcr: number[];
  confidence: number;
}

export interface PdfInspectorResult {
  pdfType: "TextBased" | "Scanned" | "ImageBased" | "Mixed";
  markdown?: string;
  pageCount: number;
  processingTimeMs: number;
  /** 1-indexed page numbers that need OCR. */
  pagesNeedingOcr: number[];
  title?: string;
  confidence: number;
  isComplexLayout: boolean;
  pagesWithTables: number[];
  pagesWithColumns: number[];
  hasEncodingIssues: boolean;
}

interface PdfInspectorModule {
  classifyPdf(buf: Buffer): PdfInspectorClassification;
  processPdf(buf: Buffer, pages?: number[] | null): PdfInspectorResult;
}

let _cached: { module: PdfInspectorModule | null; reason?: string } | null = null;

/**
 * Лениво загружает pdf-inspector. Возвращает `null` если модуль не
 * доступен — не throws. Результат кэшируется навсегда (один раз на процесс),
 * чтобы повторные импорты на каждой книге не тратили время.
 */
export async function loadPdfInspector(): Promise<PdfInspectorModule | null> {
  if (_cached) return _cached.module;
  try {
    const mod = (await import("@firecrawl/pdf-inspector")) as unknown as PdfInspectorModule;
    if (typeof mod?.classifyPdf !== "function" || typeof mod?.processPdf !== "function") {
      _cached = { module: null, reason: "module loaded but exports missing" };
      return null;
    }
    _cached = { module: mod };
    return mod;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    _cached = { module: null, reason };
    return null;
  }
}

/**
 * Diagnostic: причина по которой модуль недоступен (для warnings в parse result).
 * Возвращает `null` если loadPdfInspector ещё не вызывали ИЛИ модуль успешно
 * загрузился.
 */
export function getPdfInspectorLoadError(): string | null {
  return _cached?.reason ?? null;
}

/** Тестовый хук: сбросить мемоизацию между unit-тестами. */
export function _resetPdfInspectorCacheForTests(): void {
  _cached = null;
}
