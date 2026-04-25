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
    extras?: { conceptsAccepted?: number; conceptsExtracted?: number; lastError?: string | null },
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

  console.log(`\n[batch] ╔════════════════════════════════════════════╗`);
  console.log(`[batch] ║ BATCH START: ${args.bookIds.length} books → collection "${args.targetCollection}"`);
  console.log(`[batch] ║ minQuality=${minQ} skipFiction=${skipFw} batchId=${args.batchId}`);
  console.log(`[batch] ╚════════════════════════════════════════════╝`);

  deps.emit({
    stage: "batch", phase: "start",
    total: args.bookIds.length, minQuality: minQ, targetCollection: args.targetCollection,
  });

  const skipped: BatchSkipped[] = [];
  const eligible: Array<{ id: string; mdPath: string; title: string }> = [];

  for (const id of args.bookIds) {
    const meta = deps.getBookById(id);
    if (!meta) {
      console.log(`[batch] SKIP ${id}: not-found in cache-db`);
      skipped.push({ bookId: id, reason: "not-found" });
      continue;
    }
    const gate = gateCatalogBookForCrystallize(meta, { minQuality: minQ, skipFictionOrWater: skipFw });
    if (!gate.canCrystallize) {
      console.log(`[batch] SKIP "${meta.title}" (${id}): ${gate.reason}`);
      skipped.push({ bookId: id, reason: gate.reason ?? "not-eligible" });
      continue;
    }
    const sourcePath = resolveCatalogBookSourcePath(meta);
    console.log(`[batch] ELIGIBLE "${meta.title}" status=${meta.status} q=${meta.qualityScore} path=${sourcePath}`);
    eligible.push({ id, mdPath: sourcePath, title: meta.title });
  }

  console.log(`[batch] filter: ${eligible.length} eligible, ${skipped.length} skipped`);
  deps.emit({ stage: "batch", phase: "filtered", eligible: eligible.length, skipped: skipped.length });

  const results: BatchBookResult[] = [];

  for (let i = 0; i < eligible.length; i++) {
    if (deps.cancelSignal.aborted) {
      for (let j = i; j < eligible.length; j++) skipped.push({ bookId: eligible[j].id, reason: "batch-cancelled" });
      break;
    }
    const book = eligible[i];
    console.log(`\n[batch] ─── book ${i + 1}/${eligible.length} ─── "${book.title}" (${book.id})`);
    console.log(`[batch]   source: ${book.mdPath}`);
    deps.setBookStatus(book.id, "crystallizing", { lastError: null });
    deps.emit({ stage: "batch", phase: "book-start", bookIndex: i + 1, bookTotal: eligible.length, bookId: book.id, bookTitle: book.title });

    try {
      const r = await deps.runExtraction(
        { bookSourcePath: book.mdPath, extractModel: args.extractModel, targetCollection: args.targetCollection },
        { bookId: book.id, bookIndex: i + 1, bookTotal: eligible.length },
      );
      console.log(`[batch] ✓ "${book.title}" done: ${r.totalDelta.accepted} accepted / ${r.totalDelta.chunks} chunks / ${r.totalChapters} chapters`);
      if (r.totalDelta.accepted > 0) {
        results.push({
          bookId: book.id, bookTitle: r.bookTitle, totalChapters: r.totalChapters,
          processedChapters: r.processedChapters, accepted: r.totalDelta.accepted, skipped: r.totalDelta.skipped,
        });
        deps.setBookStatus(book.id, "indexed", {
          conceptsAccepted: r.totalDelta.accepted,
          conceptsExtracted: r.totalDelta.chunks,
          lastError: null,
        });
        deps.emit({ stage: "batch", phase: "book-done", bookIndex: i + 1, bookId: book.id, accepted: r.totalDelta.accepted });
      } else {
        const reason = r.warnings.length > 0
          ? `no accepted deltas; ${r.warnings.slice(0, 3).join(" | ")}`
          : "no accepted deltas";
        deps.setBookStatus(book.id, "failed", {
          conceptsAccepted: 0,
          conceptsExtracted: r.totalDelta.chunks,
          lastError: reason,
        });
        skipped.push({ bookId: book.id, reason });
        deps.emit({ stage: "batch", phase: "book-failed", bookIndex: i + 1, bookId: book.id, error: reason });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[batch-runner] book ${book.id} extraction failed:`, e);
      deps.setBookStatus(book.id, "failed", { lastError: msg });
      skipped.push({ bookId: book.id, reason: `extraction-failed: ${msg}` });
      deps.emit({ stage: "batch", phase: "book-failed", bookIndex: i + 1, bookId: book.id, error: msg });
    }
  }

  console.log(`\n[batch] ╔════════════════════════════════════════════╗`);
  console.log(`[batch] ║ BATCH DONE: processed=${results.length} skipped=${skipped.length} cancelled=${deps.cancelSignal.aborted}`);
  if (results.length > 0) {
    const totalAccepted = results.reduce((s, r) => s + r.accepted, 0);
    console.log(`[batch] ║ total accepted deltas: ${totalAccepted}`);
  }
  if (skipped.length > 0) {
    console.log(`[batch] ║ skip reasons:`);
    for (const s of skipped) console.log(`[batch] ║   ${s.bookId}: ${s.reason}`);
  }
  console.log(`[batch] ╚════════════════════════════════════════════╝`);
  deps.emit({ stage: "batch", phase: "done", processed: results.length, skipped: skipped.length, cancelled: deps.cancelSignal.aborted });
  return { batchId: args.batchId, total: args.bookIds.length, processed: results.length, skipped, results };
}
