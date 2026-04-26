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
  getCacheDbPath,
  queryTagStats,
  queryByDomain,
  queryByAuthor,
  queryByYear,
  queryBySphere,
  queryByTag,
  streamBookIdsByStatus,
  getBooksByIds,
  type CatalogQuery,
  type CollectionGroup,
} from "../lib/library/cache-db.js";
import { convertBookToMarkdown } from "../lib/library/md-converter.js";
import {
  importFolderToLibrary,
  importFile as importFiles,
  type ImportFolderOptions,
  type ProgressEvent,
} from "../lib/library/import.js";
import {
  bootstrapEvaluatorQueue,
  enqueueBook,
  enqueuePriority,
  pauseEvaluator,
  resumeEvaluator,
  cancelCurrentEvaluation,
  setEvaluatorModel,
  setEvaluatorSlots,
  getEvaluatorSlotCount,
  getEvaluatorStatus,
  subscribeEvaluator,
} from "../lib/library/evaluator-queue.js";
import { resolveLibraryRoot } from "../lib/library/paths.js";
import { scanFolder, type ScanReport, type ScanProgressEvent } from "../lib/library/scan-folder.js";
import { unregisterFromNearDup, resetNearDupCache } from "../lib/library/near-dup-detector.js";
import { resetRevisionDedupCache } from "../lib/library/revision-dedup.js";
import {
  getImportLogger,
  type ImportLogEntry,
  type ImportLogCategory,
  type ImportLogLevel,
} from "../lib/library/import-logger.js";
import { getPreferencesStore } from "../lib/preferences/store.js";
import type { BookCatalogMeta, BookStatus } from "../lib/library/types.js";

/**
 * Читает relevant prefs для импорта. Безопасно — если store не инициализирован
 * (например в тесте), возвращает дефолты, не throw.
 *
 * Vision-meta использует ИСКЛЮЧИТЕЛЬНО локальную LM Studio:
 *   - visionMetaEnabled — флаг (default true);
 *   - visionModelKey — override modelKey, пусто = автодетект среди загруженных.
 * Никаких облачных API — если в LM Studio нет vision-модели, импорт работает
 * без enrichment'а (graceful degradation, причина в логе).
 */
async function readImportPrefs(): Promise<{
  djvuOcrProvider: "system" | "vision-llm" | "none";
  ocrLanguages: string[];
  visionMetaEnabled: boolean;
  visionModelKey?: string;
}> {
  try {
    const store = getPreferencesStore();
    const prefs = await store.getAll();
    return {
      djvuOcrProvider: prefs.djvuOcrProvider,
      ocrLanguages: prefs.ocrLanguages ?? [],
      visionMetaEnabled: prefs.visionMetaEnabled !== false,
      visionModelKey: prefs.visionModelKey?.trim() || undefined,
    };
  } catch {
    return {
      djvuOcrProvider: "system",
      ocrLanguages: [],
      visionMetaEnabled: true,
      visionModelKey: undefined,
    };
  }
}

const SUPPORTED_FILE_FILTERS = [
  { name: "Books", extensions: ["pdf", "epub", "fb2", "docx", "doc", "rtf", "odt", "html", "htm", "txt", "djvu"] },
  { name: "Archives (will be unpacked)", extensions: ["zip", "cbz", "rar", "cbr", "7z"] },
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

/** Сколько импортов сейчас в работе. Используется в `before-quit` чтобы не закрывать app посреди работы. */
export function activeLibraryImportCount(): number {
  return activeImports.size;
}

/**
 * Грейс-завершение всех импортов: abort + ждём пока они освободят activeImports.
 * Возвращает true если успели за timeoutMs, false иначе. Используется в shutdown
 * pipeline до закрытия cache-db и BrowserWindow — иначе fs.writeFile в импорте
 * может оборваться посередине и оставить полу-битый book.md.
 */
export async function flushLibraryImports(timeoutMs: number, reason: string): Promise<boolean> {
  if (activeImports.size === 0) return true;
  for (const [, ctrl] of activeImports.entries()) ctrl.abort(reason);

  const startedAt = Date.now();
  const logger = getImportLogger();
  while (activeImports.size > 0) {
    if (Date.now() - startedAt > timeoutMs) {
      await logger.write({
        importId: "shutdown",
        level: "error",
        category: "import.crash",
        message: `flushLibraryImports: ${activeImports.size} imports still active after ${timeoutMs}ms`,
      });
      return false;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
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
  ensureImportLogBridge(getMainWindow);
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
  /* Зеркалим в logger как структурированное событие. Это даёт persistent
     audit trail в data/logs/import-*.jsonl, не зависящий от того, открыт ли UI. */
  void mirrorProgressToLogger(importId, evt);
}

function broadcastImportLog(getMainWindow: () => BrowserWindow | null, entry: ImportLogEntry): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("library:import-log", entry);
  }
}

let importLogBridgeInstalled = false;

function ensureImportLogBridge(getMainWindow: () => BrowserWindow | null): void {
  if (importLogBridgeInstalled) return;
  importLogBridgeInstalled = true;
  getImportLogger().subscribe((entry) => broadcastImportLog(getMainWindow, entry));
}

/**
 * Превращает ProgressEvent в одну структурированную лог-запись. Никаких
 * ad-hoc форматов: каждый thrown ошибки/duplicate/added имеет свою category.
 */
async function mirrorProgressToLogger(importId: string, evt: ProgressEvent): Promise<void> {
  const logger = getImportLogger();
  if (evt.phase === "discovered") {
    /* discovered события могут идти десятками тысяч в секунду — debug-уровень,
       чтобы UI не утонул, но в файл всё равно попадало. */
    if (evt.discovered % 50 === 0) {
      await logger.write({
        importId,
        level: "debug",
        category: "scan.discovered",
        message: `Discovered ${evt.discovered} files`,
      });
    }
    return;
  }
  if (evt.phase === "scan-complete") {
    await logger.write({
      importId,
      level: "info",
      category: "scan.complete",
      message: `Scan finished: ${evt.discovered} files queued for processing`,
    });
    return;
  }
  /* phase = "processed" */
  let category: ImportLogCategory;
  let level: ImportLogLevel;
  switch (evt.outcome) {
    case "added":
      category = "file.added";
      level = "info";
      break;
    case "duplicate":
      category = "file.duplicate";
      level = "info";
      break;
    case "skipped":
      category = "file.skipped";
      level = "info";
      break;
    case "failed":
      category = "file.failed";
      level = "error";
      break;
    default:
      category = "file.skipped";
      level = "info";
  }
  const baseMessage = evt.outcome === "duplicate" && evt.existingBookTitle
    ? `Duplicate of "${evt.existingBookTitle}" (${evt.duplicateReason ?? "unknown"})`
    : evt.outcome === "failed"
      ? evt.errorMessage ?? "Import failed"
      : `${evt.outcome ?? "processed"}: ${evt.processed}/${evt.discovered}`;
  await logger.write({
    importId,
    level,
    category,
    message: baseMessage,
    file: evt.currentFile,
    details: evt.fileWarnings && evt.fileWarnings.length > 0
      ? { warnings: evt.fileWarnings }
      : undefined,
  });
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
      args: { folder: string; scanArchives?: boolean; ocrEnabled?: boolean; maxDepth?: number }
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
      const logger = getImportLogger();
      const logFile = await logger.startSession(importId);
      const prefs = await readImportPrefs();
      await logger.write({
        importId, level: "info", category: "import.start",
        message: `Importing folder ${args.folder}`,
        details: {
          folder: args.folder, scanArchives: args.scanArchives === true, ocrEnabled: args.ocrEnabled === true, maxDepth: args.maxDepth, logFile,
          djvuOcrProvider: prefs.djvuOcrProvider, ocrLanguages: prefs.ocrLanguages,
          visionMetaEnabled: prefs.visionMetaEnabled, visionModelKey: prefs.visionModelKey,
        },
      });
      let endStatus: "ok" | "failed" | "cancelled" = "ok";
      try {
        const opts: ImportFolderOptions = {
          scanArchives: args.scanArchives === true,
          ocrEnabled: args.ocrEnabled === true,
          maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
          djvuOcrProvider: prefs.djvuOcrProvider,
          ocrLanguages: prefs.ocrLanguages,
          visionMetaEnabled: prefs.visionMetaEnabled,
          visionModelKey: prefs.visionModelKey,
          onProgress: (evt) => broadcastImportProgress(getMainWindow, importId, evt),
          onVisionMetaEvent: (e) => {
            const cat = e.phase === "start"
              ? "vision.start"
              : e.phase === "success" ? "vision.success" : "vision.failed";
            const lvl = e.phase === "failed" ? "warn" : "info";
            void logger.write({
              importId, level: lvl, category: cat,
              message: e.message ?? `vision-meta ${e.phase}`,
              file: e.bookFile,
              durationMs: e.durationMs,
              details: e.meta ? { meta: e.meta } : undefined,
            });
          },
          /* Каждую новую книгу немедленно ставим в очередь оценки --
             не ждём конца импорта, чтобы LLM начала работать сразу. */
          onBookImported: (meta) => {
            enqueueBook(meta.id);
            void logger.write({
              importId, level: "info", category: "evaluator.queued",
              message: `Queued for evaluation: ${meta.titleEn || meta.title || meta.id}`,
              file: meta.originalFile,
              details: { bookId: meta.id, format: meta.originalFormat, words: meta.wordCount },
            });
          },
          signal: ctrl.signal,
        };
        const result = await importFolderToLibrary(args.folder, opts);
        if (ctrl.signal.aborted) endStatus = "cancelled";
        await logger.write({
          importId, level: "info", category: "import.complete",
          message: `Import done: +${result.added} added, ${result.duplicate} dup, ${result.skipped} skip, ${result.failed} fail`,
          durationMs: Date.now() - t0,
          details: { ...result },
        });
        return { importId, ...result, durationMs: Date.now() - t0 };
      } catch (err) {
        endStatus = "failed";
        const msg = err instanceof Error ? err.message : String(err);
        await logger.write({
          importId, level: "error", category: "import.crash",
          message: `Import threw: ${msg}`,
          details: { stack: err instanceof Error ? err.stack : undefined },
        });
        throw err;
      } finally {
        activeImports.delete(importId);
        await logger.endSession({ status: endStatus });
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
      const logger = getImportLogger();
      const logFile = await logger.startSession(importId);
      const prefs = await readImportPrefs();
      await logger.write({
        importId, level: "info", category: "import.start",
        message: `Importing ${args.paths.length} files`,
        details: {
          fileCount: args.paths.length, scanArchives: args.scanArchives === true, ocrEnabled: args.ocrEnabled === true, logFile,
          djvuOcrProvider: prefs.djvuOcrProvider, ocrLanguages: prefs.ocrLanguages,
          visionMetaEnabled: prefs.visionMetaEnabled, visionModelKey: prefs.visionModelKey,
        },
      });
      const onVisionMetaEvent = (e: { phase: "start" | "success" | "failed"; bookFile: string; message?: string; durationMs?: number; meta?: unknown }) => {
        const cat = e.phase === "start" ? "vision.start" : e.phase === "success" ? "vision.success" : "vision.failed";
        const lvl = e.phase === "failed" ? "warn" : "info";
        void logger.write({
          importId, level: lvl, category: cat,
          message: e.message ?? `vision-meta ${e.phase}`,
          file: e.bookFile,
          durationMs: e.durationMs,
          details: e.meta ? { meta: e.meta } : undefined,
        });
      };
      let endStatus: "ok" | "failed" | "cancelled" = "ok";
      try {
        const aggregate = { total: 0, added: 0, duplicate: 0, skipped: 0, failed: 0, warnings: [] as string[] };
        for (let i = 0; i < args.paths.length; i++) {
          if (ctrl.signal.aborted) break;
          const p = args.paths[i];
          try {
            const itemResults = await importFiles(p, {
              scanArchives: args.scanArchives === true,
              ocrEnabled: args.ocrEnabled === true,
              signal: ctrl.signal,
              djvuOcrProvider: prefs.djvuOcrProvider,
              ocrLanguages: prefs.ocrLanguages,
              visionMetaEnabled: prefs.visionMetaEnabled,
              visionModelKey: prefs.visionModelKey,
              onVisionMetaEvent,
            });
            for (const r of itemResults) {
              aggregate.total += 1;
              aggregate[r.outcome] += 1;
              aggregate.warnings.push(...r.warnings);
              /* Симметрия с folder-импортом: каждую новую книгу немедленно
                 ставим в evaluator-queue, чтобы LLM-оценка началась
                 сразу, а не в конце большого batch. */
              if (r.outcome === "added" && r.bookId) enqueueBook(r.bookId);
            }
            broadcastImportProgress(getMainWindow, importId, {
              phase: "processed",
              discovered: args.paths.length,
              processed: i + 1,
              currentFile: p,
              outcome: itemResults[0]?.outcome ?? "failed",
              duplicateReason: itemResults[0]?.duplicateReason,
              existingBookId: itemResults[0]?.existingBookId,
              existingBookTitle: itemResults[0]?.existingBookTitle,
              index: i + 1,
              total: args.paths.length,
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            aggregate.total += 1;
            aggregate.failed += 1;
            const tagged = `${p}: ${msg}`;
            aggregate.warnings.push(`[ERROR] ${tagged}`);
            /* Раньше в этой ветке прогресс не emit'ился — UI просто видел замолчание.
               Теперь явно сигналим failed-файл, чтобы лог-панель показала причину. */
            broadcastImportProgress(getMainWindow, importId, {
              phase: "processed",
              discovered: args.paths.length,
              processed: i + 1,
              currentFile: p,
              outcome: "failed",
              errorMessage: msg,
              index: i + 1,
              total: args.paths.length,
            });
          }
        }
        if (ctrl.signal.aborted) endStatus = "cancelled";
        await logger.write({
          importId, level: "info", category: "import.complete",
          message: `Import done: +${aggregate.added} added, ${aggregate.duplicate} dup, ${aggregate.skipped} skip, ${aggregate.failed} fail`,
          details: { ...aggregate },
        });
        return { importId, ...aggregate };
      } catch (err) {
        endStatus = "failed";
        const msg = err instanceof Error ? err.message : String(err);
        await logger.write({
          importId, level: "error", category: "import.crash",
          message: `Import threw: ${msg}`,
          details: { stack: err instanceof Error ? err.stack : undefined },
        });
        throw err;
      } finally {
        activeImports.delete(importId);
        await logger.endSession({ status: endStatus });
      }
    }
  );

  ipcMain.handle("library:import-log-snapshot", async (): Promise<ImportLogEntry[]> => {
    return getImportLogger().snapshot();
  });

  ipcMain.handle("library:cancel-import", async (_e, importId: string): Promise<boolean> => {
    const ctrl = activeImports.get(importId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeImports.delete(importId);
    await getImportLogger().write({
      importId, level: "warn", category: "import.cancel",
      message: "Import cancelled by user",
    });
    return true;
  });

  ipcMain.handle(
    "library:catalog",
    async (
      _e,
      args: CatalogQuery = {}
    ): Promise<{ rows: BookCatalogMeta[]; total: number; libraryRoot: string; dbPath: string }> => {
      const result = queryCache(args);
      return {
        rows: result.rows,
        total: result.total,
        libraryRoot: resolveLibraryRoot(),
        dbPath: getCacheDbPath(),
      };
    }
  );

  ipcMain.handle("library:tag-stats", (): { tag: string; count: number }[] => {
    return queryTagStats();
  });

  ipcMain.handle("library:collection-by-domain", (): CollectionGroup[] => {
    return queryByDomain();
  });

  ipcMain.handle("library:collection-by-author", (): CollectionGroup[] => {
    return queryByAuthor();
  });

  ipcMain.handle("library:collection-by-year", (): CollectionGroup[] => {
    return queryByYear();
  });

  ipcMain.handle("library:collection-by-sphere", (): CollectionGroup[] => {
    return queryBySphere();
  });

  ipcMain.handle("library:collection-by-tag", (): CollectionGroup[] => {
    return queryByTag();
  });

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
        /* Снимаем книгу с near-dup tracker'а, иначе следующий импорт
           похожей книги получит ложное предупреждение «near-duplicate of
           {удалённый-id}». Идемпотентно. */
        unregisterFromNearDup(meta);
        resetRevisionDedupCache();
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
      /* После массовых mutations (rebuild + prune) singleton near-dup кэш
         гарантированно stale — сбрасываем, перезагрузится лениво при первом
         запросе из свежей SQLite. */
      resetNearDupCache();
      resetRevisionDedupCache();
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

      const pathMod = await import("path");
      const { promises: fsMod } = await import("fs");
      const dir = pathMod.dirname(meta.mdPath);
      const originalPath = pathMod.join(dir, meta.originalFile);

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

      await fsMod.writeFile(meta.mdPath, result.markdown, "utf-8");

      /* Сохраняем evaluator-поля из старых метаданных — не теряем оценку. */
      const updatedMeta: BookCatalogMeta = {
        ...result.meta,
        id: meta.id,
        sha256: meta.sha256,
        originalFile: meta.originalFile,
        titleEn: meta.titleEn,
        authorEn: meta.authorEn,
        domain: meta.domain,
        tags: meta.tags,
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

  // ── Pre-import scan ────────────────────────────────────────────────────────

  const activeScans = new Map<string, AbortController>();

  ipcMain.handle(
    "library:scan-folder",
    async (_e, args: { folder: string }): Promise<{ scanId: string }> => {
      if (!args || typeof args.folder !== "string") throw new Error("folder required");
      const scanId = randomUUID();
      const ctrl = new AbortController();
      activeScans.set(scanId, ctrl);

      scanFolder(args.folder, {
        scanId,
        signal: ctrl.signal,
        onProgress: (evt: ScanProgressEvent) => {
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send("library:scan-progress", evt);
          }
        },
      }).then((report: ScanReport) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("library:scan-report", { scanId, report });
        }
      }).catch((err: unknown) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("library:scan-report", {
            scanId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }).finally(() => {
        activeScans.delete(scanId);
      });

      return { scanId };
    }
  );

  ipcMain.handle(
    "library:cancel-scan",
    async (_e, scanId: string): Promise<boolean> => {
      const ctrl = activeScans.get(scanId);
      if (!ctrl) return false;
      ctrl.abort("user-cancel");
      activeScans.delete(scanId);
      return true;
    }
  );
}
