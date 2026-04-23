/**
 * Library IPC -- управление каталогом книг (file-system first + SQLite cache),
 * импорт, фоновая Pre-flight оценка, доступ к book.md.
 *
 * Архитектура:
 *   - data/library/{slug}/{original.ext, book.md} -- источник истины.
 *   - SQLite cache-db.ts -- индекс для UI, перестраиваемый из FS.
 *   - evaluator-queue.ts -- фоновый воркер LLM-оценки (один LLM-call за раз).
 *
 * Каналы:
 *   library:pick-folder              -- открыть диалог выбора папки
 *   library:pick-files               -- открыть диалог выбора файлов (поддерживаемые форматы)
 *   library:import-folder            -- импорт папки {folder, scanArchives}
 *   library:import-files             -- импорт списка файлов
 *   library:cancel-import            -- abort активного импорта
 *   library:catalog                  -- query из cache-db с фильтрами
 *   library:get-book                 -- meta + path к book.md по id
 *   library:read-book-md             -- чтение содержимого book.md
 *   library:delete-book              -- удалить из FS + DB
 *   library:rebuild-cache            -- ребилд SQLite из FS
 *   library:evaluator-status         -- состояние очереди
 *   library:evaluator-pause          -- пауза
 *   library:evaluator-resume         -- продолжить
 *   library:evaluator-cancel-current -- прервать текущую задачу (книга остаётся imported)
 *   library:evaluator-reevaluate     -- сбросить status в imported и поставить в очередь
 *   library:evaluator-set-model      -- override модели
 *
 * Push events:
 *   library:import-progress  -- {importId, stage, fileName, current, total, ...}
 *   library:evaluator-event  -- {type, bookId, ...} (см. EvaluatorEvent)
 */

import { ipcMain, dialog, type BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import {
  query as queryCache,
  getBookById,
  deleteBook as dbDeleteBook,
  rebuildFromFs,
  pruneMissing,
  upsertBook,
  type CatalogQuery,
} from "../lib/library/cache-db.js";
import {
  importFolderToLibrary,
  importFile as importFiles,
  type ImportFolderOptions,
  type ProgressEvent,
} from "../lib/library/import.js";
import {
  bootstrapEvaluatorQueue,
  enqueueBook,
  enqueueMany,
  pauseEvaluator,
  resumeEvaluator,
  cancelCurrentEvaluation,
  setEvaluatorModel,
  getEvaluatorStatus,
  subscribeEvaluator,
} from "../lib/library/evaluator-queue.js";
import { resolveLibraryRoot } from "../lib/library/paths.js";
import type { BookCatalogMeta, BookStatus } from "../lib/library/types.js";

const SUPPORTED_FILE_FILTERS = [
  { name: "Books", extensions: ["pdf", "epub", "fb2", "docx", "txt"] },
  { name: "Archives (will be unpacked)", extensions: ["zip", "cbz"] },
  { name: "All files", extensions: ["*"] },
];

const activeImports = new Map<string, AbortController>();
let evaluatorBridgeInstalled = false;

export function abortAllLibrary(reason: string): void {
  for (const [id, ctrl] of activeImports.entries()) {
    ctrl.abort(reason);
    activeImports.delete(id);
  }
  cancelCurrentEvaluation(reason);
}

/**
 * Вызывается из main.ts после registerAllIpcHandlers(). Подписывает
 * evaluator-queue на broadcast в renderer и запускает bootstrap очереди
 * (загружает все imported книги, сбрасывает застрявшие evaluating).
 *
 * Идемпотентно: повторный вызов не задублирует подписку.
 */
export async function bootstrapLibrarySubsystem(getMainWindow: () => BrowserWindow | null): Promise<void> {
  if (!evaluatorBridgeInstalled) {
    evaluatorBridgeInstalled = true;
    subscribeEvaluator((evt) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send("library:evaluator-event", evt);
      }
    });
  }
  /* Bootstrap может потерпеть неудачу если cache-db ещё не инициализирована
     (например, первый запуск без папки library). Не критично -- следующий
     импорт сам поставит книги в очередь. */
  try {
    await bootstrapEvaluatorQueue();
  } catch (err) {
    console.warn("[library] bootstrapEvaluatorQueue failed:", err instanceof Error ? err.message : err);
  }
}

function broadcastImportProgress(getMainWindow: () => BrowserWindow | null, importId: string, evt: ProgressEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("library:import-progress", { importId, ...evt });
  }
}

export function registerLibraryIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("library:pick-folder", async (): Promise<string | null> => {
    const win = getMainWindow();
    const sel = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Select folder with books",
      properties: ["openDirectory"],
    });
    if (sel.canceled || sel.filePaths.length === 0) return null;
    return sel.filePaths[0];
  });

  ipcMain.handle("library:pick-files", async (): Promise<string[]> => {
    const win = getMainWindow();
    const sel = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Select books to import",
      properties: ["openFile", "multiSelections"],
      filters: SUPPORTED_FILE_FILTERS,
    });
    if (sel.canceled || sel.filePaths.length === 0) return [];
    return sel.filePaths;
  });

  ipcMain.handle(
    "library:import-folder",
    async (
      _e,
      args: { folder: string; scanArchives?: boolean; ocrEnabled?: boolean }
    ): Promise<{
      importId: string;
      total: number;
      added: number;
      duplicate: number;
      skipped: number;
      failed: number;
      warnings: string[];
      durationMs: number;
    }> => {
      if (!args || typeof args.folder !== "string") throw new Error("folder required");
      const importId = randomUUID();
      const ctrl = new AbortController();
      activeImports.set(importId, ctrl);
      const t0 = Date.now();
      try {
        const opts: ImportFolderOptions = {
          scanArchives: args.scanArchives === true,
          ocrEnabled: args.ocrEnabled === true,
          onProgress: (evt) => broadcastImportProgress(getMainWindow, importId, evt),
          /* Каждую новую книгу немедленно ставим в очередь оценки --
             не ждём конца импорта, чтобы LLM начала работать сразу. */
          onBookImported: (meta) => enqueueBook(meta.id),
          signal: ctrl.signal,
        };
        const result = await importFolderToLibrary(args.folder, opts);
        return { importId, ...result, durationMs: Date.now() - t0 };
      } finally {
        activeImports.delete(importId);
      }
    }
  );

  ipcMain.handle(
    "library:import-files",
    async (
      _e,
      args: { paths: string[]; scanArchives?: boolean; ocrEnabled?: boolean }
    ): Promise<{
      importId: string;
      total: number;
      added: number;
      duplicate: number;
      skipped: number;
      failed: number;
      warnings: string[];
    }> => {
      if (!args || !Array.isArray(args.paths) || args.paths.length === 0) {
        throw new Error("paths required");
      }
      const importId = randomUUID();
      const ctrl = new AbortController();
      activeImports.set(importId, ctrl);
      try {
        const aggregate = { total: 0, added: 0, duplicate: 0, skipped: 0, failed: 0, warnings: [] as string[] };
        const newIds: string[] = [];
        for (let i = 0; i < args.paths.length; i++) {
          if (ctrl.signal.aborted) break;
          const p = args.paths[i];
          try {
            const itemResults = await importFiles(p, {
              scanArchives: args.scanArchives === true,
              ocrEnabled: args.ocrEnabled === true,
              signal: ctrl.signal,
            });
            for (const r of itemResults) {
              aggregate.total += 1;
              aggregate[r.outcome] += 1;
              aggregate.warnings.push(...r.warnings);
              if (r.outcome === "added" && r.bookId) newIds.push(r.bookId);
            }
            broadcastImportProgress(getMainWindow, importId, {
              index: i + 1,
              total: args.paths.length,
              currentFile: p,
              outcome: itemResults[0]?.outcome ?? "failed",
            });
          } catch (e) {
            aggregate.total += 1;
            aggregate.failed += 1;
            aggregate.warnings.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (newIds.length > 0) enqueueMany(newIds);
        return { importId, ...aggregate };
      } finally {
        activeImports.delete(importId);
      }
    }
  );

  ipcMain.handle("library:cancel-import", async (_e, importId: string): Promise<boolean> => {
    const ctrl = activeImports.get(importId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeImports.delete(importId);
    return true;
  });

  ipcMain.handle(
    "library:catalog",
    async (
      _e,
      args: CatalogQuery = {}
    ): Promise<{ rows: BookCatalogMeta[]; total: number; libraryRoot: string }> => {
      const result = queryCache(args);
      return {
        rows: result.rows,
        total: result.total,
        libraryRoot: resolveLibraryRoot(),
      };
    }
  );

  ipcMain.handle(
    "library:get-book",
    async (_e, bookId: string): Promise<(BookCatalogMeta & { mdPath: string }) | null> => {
      if (typeof bookId !== "string") return null;
      return getBookById(bookId);
    }
  );

  ipcMain.handle(
    "library:read-book-md",
    async (_e, bookId: string): Promise<{ markdown: string; mdPath: string } | null> => {
      if (typeof bookId !== "string") return null;
      const meta = getBookById(bookId);
      if (!meta) return null;
      try {
        const markdown = await fs.readFile(meta.mdPath, "utf-8");
        return { markdown, mdPath: meta.mdPath };
      } catch (e) {
        console.warn(`[library:read-book-md] ${bookId}:`, e instanceof Error ? e.message : e);
        return null;
      }
    }
  );

  ipcMain.handle(
    "library:delete-book",
    async (_e, args: { bookId: string; deleteFiles?: boolean }): Promise<{ ok: boolean; reason?: string }> => {
      if (!args || typeof args.bookId !== "string") return { ok: false, reason: "bookId required" };
      const meta = getBookById(args.bookId);
      if (!meta) return { ok: false, reason: "not-found" };
      try {
        dbDeleteBook(args.bookId);
        if (args.deleteFiles !== false) {
          /* book.md лежит в data/library/{slug}/book.md -- удаляем директорию целиком. */
          const path = await import("path");
          const dir = path.dirname(meta.mdPath);
          await fs.rm(dir, { recursive: true, force: true });
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    }
  );

  ipcMain.handle(
    "library:rebuild-cache",
    async (): Promise<{ scanned: number; ingested: number; skipped: number; pruned: number; errors: string[] }> => {
      const rebuilt = await rebuildFromFs();
      const pruned = await pruneMissing();
      return { ...rebuilt, pruned };
    }
  );

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
  ipcMain.handle(
    "library:evaluator-set-model",
    async (_e, modelKey: string | null): Promise<boolean> => {
      setEvaluatorModel(typeof modelKey === "string" && modelKey.length > 0 ? modelKey : null);
      return true;
    }
  );
}
