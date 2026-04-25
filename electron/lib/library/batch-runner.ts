/**
 * Batch runner — pure batch extraction function for the Library catalog.
 *
 * Separated from IPC handler for testability (DI for getBookById,
 * setBookStatus, runExtraction — no Electron/LLM/Qdrant required).
 */

import {
  gateCatalogBookForCrystallize,
  resolveCatalogBookSourcePath,
} from "./storage-contract.js";
import type { BookCatalogMeta, BookStatus } from "./types.js";

export interface BatchExtractionResult {
  jobId: string;
  bookTitle: string;
  totalChapters: number;
  processedChapters: number;
  totalDelta: { chunks: number; accepted: number; skipped: number };
  warnings: string[];
}

export interface BatchRunnerArgs {
  bookIds: string[];
  minQuality?: number;
  skipFictionOrWater?: boolean;
  extractModel?: string;
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
  skipped: number;
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
      targetCollection: string;
    },
    ctx: { bookId: string; bookIndex: number; bookTotal: number },
  ) => Promise<BatchExtractionResult>;
  emit: (event: Record<string, unknown>) => void;
  cancelSignal: AbortSignal;
}

export async function runBatchExtraction(
  args: BatchRunnerArgs,
  deps: BatchRunnerDeps,
): Promise<BatchSummary> {
  const minQ = typeof args.minQuality === "number" ? args.minQuality : 0;
  const skipFw = args.skipFictionOrWater !== false;

  deps.emit({
    stage: "batch", phase: "start",
    total: args.bookIds.length, minQuality: minQ, targetCollection: args.targetCollection,
  });

  const skipped: BatchSkipped[] = [];
  const eligible: Array<{ id: string; mdPath: string; title: string }> = [];

  for (const id of args.bookIds) {
    const meta = deps.getBookById(id);
    if (!meta) { skipped.push({ bookId: id, reason: "not-found" }); continue; }
    const gate = gateCatalogBookForCrystallize(meta, { minQuality: minQ, skipFictionOrWater: skipFw });
    if (!gate.canCrystallize) { skipped.push({ bookId: id, reason: gate.reason ?? "not-eligible" }); continue; }
    eligible.push({ id, mdPath: resolveCatalogBookSourcePath(meta), title: meta.title });
  }

  deps.emit({ stage: "batch", phase: "filtered", eligible: eligible.length, skipped: skipped.length });

  const results: BatchBookResult[] = [];

  for (let i = 0; i < eligible.length; i++) {
    if (deps.cancelSignal.aborted) {
      for (let j = i; j < eligible.length; j++) skipped.push({ bookId: eligible[j].id, reason: "batch-cancelled" });
      break;
    }
    const book = eligible[i];
    deps.setBookStatus(book.id, "crystallizing");
    deps.emit({ stage: "batch", phase: "book-start", bookIndex: i + 1, bookTotal: eligible.length, bookId: book.id, bookTitle: book.title });

    try {
      const r = await deps.runExtraction(
        { bookSourcePath: book.mdPath, extractModel: args.extractModel, targetCollection: args.targetCollection },
        { bookId: book.id, bookIndex: i + 1, bookTotal: eligible.length },
      );
      results.push({
        bookId: book.id, bookTitle: r.bookTitle, totalChapters: r.totalChapters,
        processedChapters: r.processedChapters, accepted: r.totalDelta.accepted, skipped: r.totalDelta.skipped,
      });
      deps.setBookStatus(book.id, "indexed", { conceptsAccepted: r.totalDelta.accepted, conceptsExtracted: r.totalDelta.chunks });
      deps.emit({ stage: "batch", phase: "book-done", bookIndex: i + 1, bookId: book.id, accepted: r.totalDelta.accepted });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.setBookStatus(book.id, "failed");
      skipped.push({ bookId: book.id, reason: `extraction-failed: ${msg}` });
      deps.emit({ stage: "batch", phase: "book-failed", bookIndex: i + 1, bookId: book.id, error: msg });
    }
  }

  deps.emit({ stage: "batch", phase: "done", processed: results.length, skipped: skipped.length, cancelled: deps.cancelSignal.aborted });
  return { batchId: args.batchId, total: args.bookIds.length, processed: results.length, skipped, results };
}
