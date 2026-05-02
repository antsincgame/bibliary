/**
 * IPC-handler'ы для evaluator-queue + reparse-book.
 *
 * Каналы:
 *   library:evaluator-status | evaluator-pause | evaluator-resume |
 *   evaluator-cancel-current
 *   library:evaluator-reevaluate | reevaluate-all | evaluator-set-model |
 *   evaluator-prioritize | evaluator-set-slots | evaluator-get-slots
 *   library:reparse-book
 *
 * Извлечено из `library.ipc.ts` (Phase 3.1 cross-platform roadmap, 2026-04-30).
 */

import { ipcMain } from "electron";
import {
  getBookById,
  upsertBook,
  streamBookIdsByStatus,
  getBooksByIds,
} from "../lib/library/cache-db.js";
import { convertBookToMarkdown } from "../lib/library/md-converter.js";
import {
  enqueueBook,
  enqueuePriority,
  pauseEvaluator,
  resumeEvaluator,
  cancelCurrentEvaluation,
  setEvaluatorModel,
  setEvaluatorSlots,
  getEvaluatorSlotCount,
  getEvaluatorStatus,
} from "../lib/library/evaluator-queue.js";
import { resolveCatalogSidecarPaths } from "../lib/library/storage-contract.js";
import { withBookMdLock } from "../lib/library/book-md-mutex.js";
import type { BookCatalogMeta, BookStatus } from "../lib/library/types.js";

export function registerLibraryEvaluatorIpc(): void {
  ipcMain.handle("library:evaluator-status", async () => getEvaluatorStatus());
  ipcMain.handle("library:evaluator-pause", async (): Promise<boolean> => {
    pauseEvaluator();
    return true;
  });
  ipcMain.handle("library:evaluator-resume", async (): Promise<boolean> => {
    resumeEvaluator();
    return true;
  });
  ipcMain.handle("library:evaluator-cancel-current", async (): Promise<boolean> => {
    cancelCurrentEvaluation("user-cancel");
    return true;
  });
  ipcMain.handle(
    "library:evaluator-reevaluate",
    async (_e, args: { bookId: string }): Promise<{ ok: boolean; reason?: string }> => {
      if (!args || typeof args.bookId !== "string") return { ok: false, reason: "bookId required" };
      const meta = getBookById(args.bookId);
      if (!meta) return { ok: false, reason: "not-found" };
      /* Reset status to imported -- evaluator подберёт. mdPath сохраняется. */
      const reset: BookCatalogMeta = { ...meta, status: "imported" as BookStatus };
      upsertBook(reset, meta.mdPath);
      enqueueBook(args.bookId);
      return { ok: true };
    }
  );
  ipcMain.handle("library:reevaluate-all", async (): Promise<{ queued: number }> => {
    const statuses: BookStatus[] = ["evaluated", "indexed", "crystallizing"];
    const pageSize = 500;
    let cursor: string | null = null;
    let queued = 0;
    while (true) {
      const { ids, nextCursor } = streamBookIdsByStatus(statuses, pageSize, cursor);
      if (ids.length === 0) break;
      const rows = getBooksByIds(ids);
      for (const meta of rows) {
        const reset: BookCatalogMeta = { ...meta, status: "imported" as BookStatus };
        upsertBook(reset, meta.mdPath);
        enqueueBook(meta.id);
        queued += 1;
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return { queued };
  });
  ipcMain.handle(
    "library:evaluator-set-model",
    async (_e, modelKey: string | null): Promise<boolean> => {
      setEvaluatorModel(typeof modelKey === "string" && modelKey.length > 0 ? modelKey : null);
      return true;
    }
  );
  /* Priority enqueue: UI-flow «оценить эти первыми» (selected rows). */
  ipcMain.handle(
    "library:evaluator-prioritize",
    async (_e, args: { bookIds: string[] }): Promise<{ ok: boolean; queued: number }> => {
      if (!args || !Array.isArray(args.bookIds)) return { ok: false, queued: 0 };
      let queued = 0;
      /* Reverse order: при unshift каждой следующей она оттесняет предыдущую,
         так что итоговый порядок = тот, что передал caller. */
      for (let i = args.bookIds.length - 1; i >= 0; i--) {
        const id = args.bookIds[i];
        if (typeof id === "string" && id.length > 0) {
          enqueuePriority(id);
          queued += 1;
        }
      }
      return { ok: true, queued };
    }
  );
  /* Runtime regulation параллелизма evaluator. UI слайдер 1..16. */
  ipcMain.handle(
    "library:evaluator-set-slots",
    async (_e, n: number): Promise<{ ok: boolean; slots: number }> => {
      if (!Number.isInteger(n) || n < 1) return { ok: false, slots: getEvaluatorSlotCount() };
      setEvaluatorSlots(n);
      return { ok: true, slots: getEvaluatorSlotCount() };
    }
  );
  ipcMain.handle("library:evaluator-get-slots", async (): Promise<number> => getEvaluatorSlotCount());

  /**
   * Перепарсить книгу заново по сохранённому оригинальному файлу.
   * Полезно для книг со статусом "unsupported" после улучшения парсеров
   * или включения OCR. После успешного перепарсинга статус сбрасывается
   * в "imported" и книга ставится в очередь на эвалюацию.
   */
  ipcMain.handle(
    "library:reparse-book",
    async (_e, bookId: string): Promise<{ ok: boolean; chapters?: number; reason?: string }> => {
      if (typeof bookId !== "string") return { ok: false, reason: "bookId required" };
      const meta = getBookById(bookId);
      if (!meta) return { ok: false, reason: "not-found" };

      const { promises: fsMod } = await import("fs");
      const sidecars = await resolveCatalogSidecarPaths(meta);
      const originalPath = sidecars.originalPath;

      try {
        await fsMod.access(originalPath);
      } catch {
        return { ok: false, reason: `original file not found: ${meta.originalFile}` };
      }

      let result: Awaited<ReturnType<typeof convertBookToMarkdown>>;
      try {
        result = await convertBookToMarkdown(originalPath, {
          precomputedSha256: meta.sha256,
          ocrEnabled: true,
        });
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }

      if (result.chapters.length === 0) {
        const warn = result.meta.warnings?.slice(0, 3).join("; ") ?? "no chapters extracted";
        return { ok: false, reason: warn };
      }

      /* Иt 8Г.1: reparse полностью переписывает md → не должно гонкой
         перетереть параллельный evaluator/illustration update той же книги. */
      await withBookMdLock(meta.id, () =>
        fsMod.writeFile(meta.mdPath, result.markdown, "utf-8"),
      );

      /* Сохраняем evaluator-поля из старых метаданных — не теряем оценку. */
      const updatedMeta: BookCatalogMeta = {
        ...result.meta,
        id: meta.id,
        sha256: meta.sha256,
        originalFile: meta.originalFile,
        titleRu: meta.titleRu,
        authorRu: meta.authorRu,
        titleEn: meta.titleEn,
        authorEn: meta.authorEn,
        domain: meta.domain,
        tags: meta.tags,
        tagsRu: meta.tagsRu,
        qualityScore: meta.qualityScore,
        conceptualDensity: meta.conceptualDensity,
        originality: meta.originality,
        isFictionOrWater: meta.isFictionOrWater,
        verdictReason: meta.verdictReason,
        evaluatorModel: meta.evaluatorModel,
        evaluatedAt: meta.evaluatedAt,
        status: "imported",
        lastError: undefined,
      };
      upsertBook(updatedMeta, meta.mdPath);
      enqueueBook(meta.id);

      return { ok: true, chapters: result.chapters.length };
    }
  );
}
