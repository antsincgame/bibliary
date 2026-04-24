/* Pure batch-extract core extracted from dataset-v2.ipc.ts so it can be tested without ipcMain. */
/**
 * Batch runner — чистая функция batch-кристаллизации книг из Library.
 *
 * Зачем выделено из `electron/ipc/dataset-v2.ipc.ts`:
 *   1. Тестируемость: IPC handler требовал поднятия Electron + ipcMain mock.
 *      Теперь purelogic тестируется на DI: подменяем `getBookById`,
 *      `setBookStatus`, `runExtraction` -- и проверяем filter/abort/error
 *      recovery без LLM/Qdrant.
 *   2. SRP: handler стал тонкой адапт-прослойкой, основная семантика
 *      батча живёт в одном месте.
 *
 * Контракт совпадает с прежним handler'ом ноль-в-ноль:
 *   - Гейт `gateCatalogBookForCrystallize` отсеивает книги до запуска LLM.
 *   - Каждая ошибка одной книги НЕ останавливает батч (помечается `failed`).
 *   - `cancelSignal.aborted` → оставшиеся книги идут в skipped с
 *     причиной `batch-cancelled`.
 *   - Каждая успешная книга получает финальный `setBookStatus("indexed")`
 *     с `conceptsAccepted`/`conceptsExtracted`.
 */

import {
  gateCatalogBookForCrystallize,
  resolveCatalogBookSourcePath,
} from "./storage-contract.js";
import type { BookCatalogMeta, BookStatus } from "./types.js";

/** Совпадает с возвратом `runExtraction` из dataset-v2.ipc.ts. */
export interface BatchExtractionResult {
  jobId: string;
  bookTitle: string;
  totalChapters: number;
  processedChapters: number;
  totalConcepts: { extractedRaw: number; afterDedup: number; accepted: number; rejected: number };
  warnings: string[];
}

export interface BatchRunnerArgs {
  bookIds: string[];
  minQuality?: number;
  skipFictionOrWater?: boolean;
  extractModel?: string;
  judgeModel?: string;
  scoreThreshold?: number;
  /** Тематическая Qdrant-коллекция (валидируется снаружи). */
  targetCollection: string;
  batchId: string;
}

export interface BatchSkipped {
  bookId: string;
  reason: string;
}

export interface BatchBookResult {
  bookId: string;
  bookTitle: string;
  totalChapters: number;
  processedChapters: number;
  accepted: number;
  rejected: number;
}

export interface BatchSummary {
  batchId: string;
  total: number;
  processed: number;
  skipped: BatchSkipped[];
  results: BatchBookResult[];
}

export interface BatchRunnerDeps {
  getBookById: (id: string) => (BookCatalogMeta & { mdPath: string }) | null;
  setBookStatus: (
    id: string,
    status: BookStatus,
    extras?: { conceptsAccepted?: number; conceptsExtracted?: number },
  ) => boolean;
  runExtraction: (
    args: {
      bookSourcePath: string;
      extractModel?: string;
      judgeModel?: string;
      scoreThreshold?: number;
      targetCollection: string;
    },
    /* Передаём bookId/bookIndex факторке: внутренний emit (parse/extract/judge)
       подмешает их к каждому событию -- renderer сразу видит, к какой
       книге батча относится конкретный chunk-progress. */
    ctx: { bookId: string; bookIndex: number; bookTotal: number },
  ) => Promise<BatchExtractionResult>;
  emit: (event: Record<string, unknown>) => void;
  cancelSignal: AbortSignal;
}

/**
 * Главная точка входа батча. Логика:
 *   1. Filter: gate → eligible/skipped (без LLM).
 *   2. Loop: для каждой eligible книги setStatus("crystallizing") →
 *      runExtraction → setStatus("indexed" | "failed").
 *   3. Cancel: при abort оставшиеся падают в skipped.
 *
 * Никогда не throw -- результаты возвращаются как сводка, ошибки
 * каждой книги -- внутри `skipped`.
 */
export async function runBatchExtraction(
  args: BatchRunnerArgs,
  deps: BatchRunnerDeps,
): Promise<BatchSummary> {
  const minQ = typeof args.minQuality === "number" ? args.minQuality : 70;
  const skipFw = args.skipFictionOrWater !== false;

  deps.emit({
    stage: "batch",
    phase: "start",
    total: args.bookIds.length,
    minQuality: minQ,
    targetCollection: args.targetCollection,
  });

  const skipped: BatchSkipped[] = [];
  const eligible: Array<{ id: string; mdPath: string; title: string }> = [];

  for (const id of args.bookIds) {
    const meta = deps.getBookById(id);
    if (!meta) {
      skipped.push({ bookId: id, reason: "not-found" });
      continue;
    }
    const gate = gateCatalogBookForCrystallize(meta, {
      minQuality: minQ,
      skipFictionOrWater: skipFw,
    });
    if (!gate.canCrystallize) {
      skipped.push({ bookId: id, reason: gate.reason ?? "not-eligible" });
      continue;
    }
    const sourcePath = resolveCatalogBookSourcePath(meta);
    eligible.push({ id, mdPath: sourcePath, title: meta.title });
  }

  deps.emit({ stage: "batch", phase: "filtered", eligible: eligible.length, skipped: skipped.length });

  const results: BatchBookResult[] = [];

  for (let i = 0; i < eligible.length; i++) {
    if (deps.cancelSignal.aborted) {
      for (let j = i; j < eligible.length; j++) {
        skipped.push({ bookId: eligible[j].id, reason: "batch-cancelled" });
      }
      break;
    }
    const book = eligible[i];
    deps.setBookStatus(book.id, "crystallizing");
    deps.emit({
      stage: "batch",
      phase: "book-start",
      bookIndex: i + 1,
      bookTotal: eligible.length,
      bookId: book.id,
      bookTitle: book.title,
    });

    try {
      const r = await deps.runExtraction(
        {
          bookSourcePath: book.mdPath,
          extractModel: args.extractModel,
          judgeModel: args.judgeModel,
          scoreThreshold: args.scoreThreshold,
          targetCollection: args.targetCollection,
        },
        { bookId: book.id, bookIndex: i + 1, bookTotal: eligible.length },
      );
      results.push({
        bookId: book.id,
        bookTitle: r.bookTitle,
        totalChapters: r.totalChapters,
        processedChapters: r.processedChapters,
        accepted: r.totalConcepts.accepted,
        rejected: r.totalConcepts.rejected,
      });
      deps.setBookStatus(book.id, "indexed", {
        conceptsAccepted: r.totalConcepts.accepted,
        conceptsExtracted: r.totalConcepts.extractedRaw,
      });
      deps.emit({
        stage: "batch",
        phase: "book-done",
        bookIndex: i + 1,
        bookId: book.id,
        accepted: r.totalConcepts.accepted,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.setBookStatus(book.id, "failed");
      skipped.push({ bookId: book.id, reason: `extraction-failed: ${msg}` });
      deps.emit({
        stage: "batch",
        phase: "book-failed",
        bookIndex: i + 1,
        bookId: book.id,
        error: msg,
      });
    }
  }

  const cancelled = deps.cancelSignal.aborted;
  deps.emit({
    stage: "batch",
    phase: "done",
    processed: results.length,
    skipped: skipped.length,
    cancelled,
  });

  return {
    batchId: args.batchId,
    total: args.bookIds.length,
    processed: results.length,
    skipped,
    results,
  };
}
