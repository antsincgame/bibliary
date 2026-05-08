/**
 * Dataset v2 IPC — barrel + handlers.
 *
 * Один публичный метод `dataset-v2:start-extraction` запускает Stages 1-4 на
 * одной книге (или диапазоне глав). Прогресс летит push-events `dataset-v2:event`
 * в renderer для alchemy log.
 *
 * Декомпозиция (Phase 3.2 cross-platform roadmap, 2026-04-30):
 *   - Shared state + lifecycle → `dataset-v2-ipc-state.ts`
 *   - Core extraction routine → `electron/lib/dataset-v2/extraction-runner.ts`
 *   - В этом файле остались только `ipcMain.handle` обёртки.
 */

import { ipcMain, dialog, shell, type BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import { coordinator } from "../lib/resilience/batch-coordinator.js";
import { runBatchExtraction } from "../lib/library/batch-runner.js";
import {
  trackExtractionJob,
  untrackExtractionJob,
} from "../lib/dataset-v2/coordinator-pipeline.js";
import { assertValidCollectionName } from "../lib/dataset-v2/index.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import {
  runExtraction,
  type StartExtractionArgs,
  type StartExtractionResult,
} from "../lib/dataset-v2/extraction-runner.js";
import {
  activeJobs,
  activeBatches,
  DEFAULT_COLLECTION,
} from "./dataset-v2-ipc-state.js";

export {
  abortAllDatasetV2,
  killAllSynthChildren,
} from "./dataset-v2-ipc-state.js";

let unregisterDatasetLlmProbe: (() => void) | null = null;

export function registerDatasetV2Ipc(getMainWindow: () => BrowserWindow | null): void {
  if (!unregisterDatasetLlmProbe) {
    unregisterDatasetLlmProbe = globalLlmLock.registerProbe("dataset-v2", () => {
      const active = activeJobs.size + activeBatches.size;
      return { busy: active > 0, reason: `${active} extraction job(s)` };
    });
  }

  const broadcast = (event: Record<string, unknown>): void => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("dataset-v2:event", event);
    }
  };

  ipcMain.handle(
    "dataset-v2:start-extraction",
    async (_e, args: StartExtractionArgs): Promise<StartExtractionResult> => {
      return runExtraction(args, broadcast);
    }
  );

  ipcMain.handle("dataset-v2:cancel", async (_e, jobId: string): Promise<boolean> => {
    const ctrl = activeJobs.get(jobId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeJobs.delete(jobId);
    untrackExtractionJob(jobId);
    coordinator.reportBatchEnd(jobId);
    return true;
  });

  /**
   * Batch crystallization для нескольких книг подряд из Library каталога.
   *
   * Guard: каждая книга должна быть `evaluated` И иметь `qualityScore >= minQuality`
   * И не быть `is_fiction_or_water=true` (если фильтр включён). Иначе книга
   * скипается с warning -- мы НЕ тратим LLM на мусор.
   *
   * Прогресс батча летит как `dataset-v2:event` с `bookIndex`/`bookTotal`/`bookId`,
   * а внутри каждой книги -- обычные события parse/extract/judge.
   */
  ipcMain.handle(
    "dataset-v2:start-batch",
    async (
      _e,
      args: {
        bookIds: string[];
        minQuality?: number;
        skipFictionOrWater?: boolean;
        extractModel?: string;
        targetCollection?: string;
      }
    ): Promise<{
      batchId: string;
      total: number;
      processed: number;
      skipped: Array<{ bookId: string; reason: string }>;
      results: Array<{
        bookId: string;
        bookTitle: string;
        totalChapters: number;
        processedChapters: number;
        accepted: number;
        skipped: number;
      }>;
    }> => {
      if (!args || !Array.isArray(args.bookIds) || args.bookIds.length === 0) {
        throw new Error("bookIds required");
      }
      /* Резолвим коллекцию ОДИН раз для всего батча. Все книги пишут
         в одну тематическую коллекцию -- это и есть смысл батча. */
      const targetCollection = args.targetCollection ?? DEFAULT_COLLECTION;
      assertValidCollectionName(targetCollection);

      const { getBookById, setBookStatus } = await import("../lib/library/cache-db.js");
      const batchId = randomUUID();

      /* Iter 7: один AbortController на весь батч. cancel-batch handler
         его abort()-ит, batch-runner выходит между книгами. */
      const batchCtrl = new AbortController();
      activeBatches.set(batchId, batchCtrl);

      try {
        const summary = await runBatchExtraction(
          { ...args, targetCollection, batchId },
          {
            getBookById,
            setBookStatus,
            cancelSignal: batchCtrl.signal,
            emit: (event) => broadcast({ batchId, ...event }),
            runExtraction: async (extractionArgs, ctx) => {
              /* Per-book emitter подмешивает bookIndex/bookId через
                 broadcast: каждое внутреннее extract/chunker/judge
                 событие летит с правильным bookId, не теряется. */
              const perBookEmit = (event: Record<string, unknown>): void =>
                broadcast({
                  batchId,
                  bookIndex: ctx.bookIndex,
                  bookTotal: ctx.bookTotal,
                  bookId: ctx.bookId,
                  ...event,
                });
              return runExtraction(extractionArgs, perBookEmit);
            },
          },
        );
        return summary;
      } finally {
        activeBatches.delete(batchId);
      }
    }
  );

  /**
   * Iter 7: cancel-batch — прерывает батч-цикл целиком.
   *
   * Контракт:
   *   1. Ставит abort на batchCtrl → цикл for(let i…) выходит ПЕРЕД
   *      следующей итерацией.
   *   2. Если в этот момент уже работает runExtraction (текущая книга),
   *      она доработает до конца.
   *   3. Возвращает `true` если батч был активен, `false` если уже завершён.
   */
  ipcMain.handle("dataset-v2:cancel-batch", async (_e, batchId: string): Promise<boolean> => {
    const ctrl = activeBatches.get(batchId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel-batch");
    activeBatches.delete(batchId);
    return true;
  });

  /**
   * Сколько концептов в выбранной коллекции (для UI бейджа).
   */
  ipcMain.handle(
    "dataset-v2:list-accepted",
    async (_e, collection?: string): Promise<{ total: number; byDomain: Record<string, number>; collection: string }> => {
      const { vectorCount, scrollVectors } = await import("../lib/vectordb/index.js");
      const targetCollection = collection ?? DEFAULT_COLLECTION;
      try {
        assertValidCollectionName(targetCollection);
      } catch (e) {
        console.warn(`[dataset-v2:list-accepted] ${e instanceof Error ? e.message : e}`);
        return { total: 0, byDomain: {}, collection: targetCollection };
      }
      try {
        const total = await vectorCount(targetCollection);
        const byDomain: Record<string, number> = {};

        if (total > 50_000) {
          console.warn(
            `[dataset-v2:list-accepted] domain breakdown skipped: ${targetCollection} has ${total} points (> 50000 cap)`
          );
        }
        if (total > 0 && total <= 50_000) {
          for await (const page of scrollVectors({
            tableName: targetCollection,
            include: ["metadatas"],
            pageSize: 1000,
            maxItems: 50_000,
          })) {
            for (const m of page.metadatas ?? []) {
              const d = (m && typeof m.domain === "string" ? m.domain : "unknown") as string;
              byDomain[d] = (byDomain[d] || 0) + 1;
            }
          }
        }

        return { total, byDomain, collection: targetCollection };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[dataset-v2:list-accepted] vectordb unavailable for ${targetCollection}: ${msg}`);
        return { total: 0, byDomain: {}, collection: targetCollection };
      }
    }
  );

  /**
   * Удалить концепт из выбранной коллекции (manual rejection пользователем).
   */
  ipcMain.handle(
    "dataset-v2:reject-accepted",
    async (_e, conceptId: string, collection?: string): Promise<boolean> => {
      if (typeof conceptId !== "string" || conceptId.length === 0) return false;
      const targetCollection = collection ?? DEFAULT_COLLECTION;
      try {
        assertValidCollectionName(targetCollection);
      } catch (e) {
        console.warn(`[dataset-v2:reject-accepted] ${e instanceof Error ? e.message : e}`);
        return false;
      }
      try {
        const { vectorDeleteByWhere } = await import("../lib/vectordb/index.js");
        /* По id — single point delete. id хранится как первичная колонка
         * в таблице, фильтр через filter.ts → SQL `id = '...'`. */
        await vectorDeleteByWhere(targetCollection, { id: String(conceptId) });
        return true;
      } catch (e) {
        console.warn(`[dataset-v2:reject-accepted] vectordb delete failed: ${e instanceof Error ? e.message : e}`);
        return false;
      }
    }
  );

  /**
   * dataset-v2:synthesize — in-process LLM-синтез.
   */
  ipcMain.handle(
    "dataset-v2:synthesize",
    async (
      _e,
      args: {
        collection: string;
        outputDir: string;
        format: "sharegpt" | "chatml";
        pairsPerConcept: number;
        model: string;
        trainRatio?: number;
        limit?: number;
      },
    ): Promise<{
      ok: boolean;
      jobId?: string;
      error?: string;
      stats?: import("../lib/dataset-v2/synthesize.js").SynthStats;
    }> => {
      try {
        if (!args || typeof args !== "object") {
          return { ok: false, error: "invalid args" };
        }
        const collection = String(args.collection ?? "").trim() || DEFAULT_COLLECTION;
        const outputDir = String(args.outputDir ?? "").trim();
        const format = args.format === "chatml" ? "chatml" : "sharegpt";
        const pairs = Math.max(1, Math.min(5, Number(args.pairsPerConcept) || 2));
        const model = String(args.model ?? "").trim();

        if (!outputDir) return { ok: false, error: "не выбрана папка для сохранения" };
        if (!model) return { ok: false, error: "не выбрана модель LM Studio" };

        try {
          assertValidCollectionName(collection);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }

        const jobId = randomUUID();
        const ctrl = new AbortController();
        activeJobs.set(jobId, ctrl);
        trackExtractionJob(jobId, ctrl);
        coordinator.reportBatchStart({
          pipeline: "extraction",
          batchId: jobId,
          startedAt: new Date().toISOString(),
          config: { kind: "synth", collection, model, format, pairs },
        });

        const win = getMainWindow();
        const emit = (extra: Record<string, unknown>): void => {
          win?.webContents.send("dataset-v2:event", {
            jobId,
            stage: "synth",
            ...extra,
          });
        };

        try {
          emit({ phase: "start", collection, model, pairs, format });
          const { synthesizeDataset } = await import("../lib/dataset-v2/synthesize.js");
          const stats = await synthesizeDataset({
            collection,
            outputDir,
            format,
            pairsPerConcept: pairs,
            model,
            trainRatio: typeof args.trainRatio === "number" ? args.trainRatio : 0.9,
            limit: typeof args.limit === "number" && args.limit > 0 ? args.limit : undefined,
            signal: ctrl.signal,
            onProgress: (info) => emit({ ...info, phase: "progress" }),
          });
          emit({ phase: "done", stats });
          return { ok: true, jobId, stats };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          console.warn("[dataset-v2:synthesize] failed:", error);
          emit({ phase: "error", error });
          return { ok: false, jobId, error };
        } finally {
          activeJobs.delete(jobId);
          untrackExtractionJob(jobId);
          coordinator.reportBatchEnd(jobId);
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return { ok: false, error };
      }
    },
  );

  /**
   * dataset-v2:pick-export-dir — open native folder picker.
   */
  ipcMain.handle("dataset-v2:pick-export-dir", async (): Promise<string | null> => {
    const win = getMainWindow();
    const sel = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Куда сохранить датасет",
      properties: ["openDirectory", "createDirectory"],
    });
    if (sel.canceled || sel.filePaths.length === 0) return null;
    return sel.filePaths[0] ?? null;
  });

  /**
   * dataset-v2:open-folder — reveal exported dataset folder in OS file manager.
   */
  ipcMain.handle("dataset-v2:open-folder", async (_e, dirPath: string): Promise<boolean> => {
    if (typeof dirPath !== "string" || dirPath.length === 0) return false;
    try {
      await shell.openPath(dirPath);
      return true;
    } catch (e) {
      console.warn("[dataset-v2:open-folder] failed:", e instanceof Error ? e.message : e);
      return false;
    }
  });

  /**
   * dataset-v2:export-dataset — read accepted concepts from vectordb collection
   * and emit train.jsonl + val.jsonl + meta.json + README.md in chosen format.
   * Pure template-based (no LLM call), so it runs in seconds even for large
   * collections and never blocks LM Studio.
   */
  ipcMain.handle(
    "dataset-v2:export-dataset",
    async (
      _e,
      args: {
        collection: string;
        outputDir: string;
        format: "sharegpt" | "chatml";
        pairsPerConcept: number;
        trainRatio?: number;
        limit?: number;
      },
    ): Promise<{
      ok: boolean;
      error?: string;
      stats?: {
        concepts: number;
        totalLines: number;
        trainLines: number;
        valLines: number;
        outputDir: string;
        format: "sharegpt" | "chatml";
        files: string[];
        byDomain: Record<string, number>;
      };
    }> => {
      try {
        if (!args || typeof args !== "object") {
          return { ok: false, error: "invalid args" };
        }
        const collection = String(args.collection ?? "").trim() || DEFAULT_COLLECTION;
        const outputDir = String(args.outputDir ?? "").trim();
        const format = args.format === "chatml" ? "chatml" : "sharegpt";
        const pairs = Math.max(1, Math.min(5, Number(args.pairsPerConcept) || 1));
        if (!outputDir) return { ok: false, error: "не выбрана папка" };

        try {
          assertValidCollectionName(collection);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }

        const win = getMainWindow();
        const emit = (linesEmitted: number, conceptsRead: number) => {
          win?.webContents.send("dataset-v2:event", {
            stage: "export",
            phase: "progress",
            conceptsRead,
            linesEmitted,
          });
        };

        const { exportDataset } = await import("../lib/dataset-v2/export.js");
        const stats = await exportDataset({
          collection,
          outputDir,
          format,
          pairsPerConcept: pairs,
          trainRatio: typeof args.trainRatio === "number" ? args.trainRatio : 0.9,
          limit: typeof args.limit === "number" && args.limit > 0 ? args.limit : undefined,
          onProgress: (info) => emit(info.linesEmitted, info.conceptsRead),
        });

        win?.webContents.send("dataset-v2:event", {
          stage: "export",
          phase: "done",
          stats,
        });

        return { ok: true, stats };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn("[dataset-v2:export-dataset] failed:", error);
        return { ok: false, error };
      }
    },
  );
}
