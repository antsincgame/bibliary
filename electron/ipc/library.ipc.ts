/**
 * Library IPC -- управление каталогом книг (file-system first + SQLite cache),
 * импорт, фоновая Pre-flight оценка, доступ к book.md.
 *
 * Архитектура:
 *   - data/library/{slug}/{original.ext, book.md} -- источник истины.
 *   - SQLite cache-db.ts -- индекс для UI, перестраиваемый из FS.
 *   - evaluator-queue.ts -- фоновый воркер LLM-оценки (один LLM-call за раз).
 *
 * Пути с renderer: `parseOrThrow` + `AbsoluteFilePathSchema` / `LibraryImportFilePathsSchema`
 * (`electron/ipc/validators.ts`) — как в `scanner.ipc.ts` / `qdrant.ipc.ts`.
 *
 * Каналы (invoke) — см. также `preload.ts` → `api.library`:
 *   library:pick-folder | pick-files
 *   library:import-folder | import-files | cancel-import
 *   library:import-log-snapshot
 *   library:catalog | tag-stats | collection-by-{domain,author,year,sphere,tag}
 *   library:get-book | read-book-md | delete-book | rebuild-cache
 *   library:evaluator-status | evaluator-pause | evaluator-resume | evaluator-cancel-current
 *   library:evaluator-reevaluate | reevaluate-all | evaluator-set-model | evaluator-prioritize
 *   library:evaluator-set-slots | evaluator-get-slots
 *   library:reparse-book
 *   library:scan-folder | cancel-scan
 *
 * Push events (main → renderer):
 *   library:import-progress | library:import-log
 *   library:evaluator-event
 *   library:scan-progress | library:scan-report
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
  ensureEvaluatorBootstrap,
  enqueueBook,
  enqueuePriority,
  pauseEvaluator,
  resumeEvaluator,
  cancelCurrentEvaluation,
  clearQueue,
  setEvaluatorModel,
  setEvaluatorSlots,
  getEvaluatorSlotCount,
  getEvaluatorStatus,
  subscribeEvaluator,
  activeSlotCount as evaluatorActiveSlotCount,
} from "../lib/library/evaluator-queue.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import { resolveLibraryRoot } from "../lib/library/paths.js";
import {
  AbsoluteFilePathSchema,
  LibraryImportFilePathsSchema,
  parseOrThrow,
} from "./validators.js";
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
  metadataOnlineLookup: boolean;
}> {
  try {
    const store = getPreferencesStore();
    const prefs = await store.getAll();
    return {
      djvuOcrProvider: prefs.djvuOcrProvider,
      ocrLanguages: prefs.ocrLanguages ?? [],
      visionMetaEnabled: prefs.visionMetaEnabled === true,
      visionModelKey: prefs.visionModelKey?.trim() || undefined,
      metadataOnlineLookup: prefs.metadataOnlineLookup !== false,
    };
  } catch {
    return {
      djvuOcrProvider: "system",
      ocrLanguages: [],
      visionMetaEnabled: false,
      visionModelKey: undefined,
      metadataOnlineLookup: true,
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
  pauseEvaluator();
  clearQueue();
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
  registerLibraryLlmLockProbes();
  /* Bootstrap запускается лениво: первый вызов enqueueBook или runSlot
     запустит ensureEvaluatorBootstrap автоматически. Здесь kick-off чтобы
     bootstrap начался сразу при старте, а не только при первом импорте.
     Не await'им — не блокируем startup IPC регистрацию. */
  void ensureEvaluatorBootstrap();
}

let llmLockProbesRegistered = false;
/**
 * Регистрирует два probe в GlobalLlmLock — для library import и evaluator queue.
 * Они нужны Arena scheduler'у чтобы НЕ запускать калибровку пока LM Studio
 * занята массовым импортом или фоновым evaluator (защита от OOM, см.
 * docs/MODEL-ROLES.md и electron/lib/llm/global-llm-lock.ts).
 *
 * Vision-meta inline вызывается внутри importBookFromFile, поэтому отдельного
 * probe для vision не нужно — `library-import` его уже покрывает.
 *
 * Идемпотентно: повторный вызов не дублирует probes (registerProbe overwrites).
 */
function registerLibraryLlmLockProbes(): void {
  if (llmLockProbesRegistered) return;
  llmLockProbesRegistered = true;
  globalLlmLock.registerProbe("library-import", () => {
    const n = activeImports.size;
    return n === 0
      ? { busy: false }
      : { busy: true, reason: `${n} active import(s) (vision-meta inline)` };
  });
  globalLlmLock.registerProbe("evaluator-queue", () => {
    const n = evaluatorActiveSlotCount();
    return n === 0
      ? { busy: false }
      : { busy: true, reason: `${n} evaluator slot(s) running` };
  });
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
      /* Пропуск с причиной (magic-guard, cross-format, broken file) — это
         деградация, должен быть warn-уровня, чтобы счётчик WARN в UI
         отражал реальные «потерянные» файлы. Чистый duplicate-skip без
         errorMessage остаётся info (нечего показывать пользователю). */
      level = evt.errorMessage ? "warn" : "info";
      break;
    case "failed":
      category = "file.failed";
      level = "error";
      break;
    default:
      category = "file.skipped";
      level = "info";
  }
  /* baseMessage всегда содержит максимум контекста: тип события + причина.
     Для skipped с reason раньше пользователь видел только "skipped: 5/42"
     и причина терялась в details. Теперь причина в message — видна сразу
     в одной строке. */
  let baseMessage: string;
  if (evt.outcome === "duplicate" && evt.existingBookTitle) {
    baseMessage = `Duplicate of "${evt.existingBookTitle}" (${evt.duplicateReason ?? "unknown"})`;
  } else if (evt.outcome === "failed") {
    baseMessage = evt.errorMessage ?? "Import failed";
  } else if (evt.outcome === "skipped" && evt.errorMessage) {
    baseMessage = `Skipped: ${evt.errorMessage}`;
  } else {
    baseMessage = `${evt.outcome ?? "processed"}: ${evt.processed}/${evt.discovered}`;
  }
  await logger.write({
    importId,
    level,
    category,
    message: baseMessage,
    file: evt.currentFile,
    details: {
      ...(evt.fileWarnings && evt.fileWarnings.length > 0 ? { warnings: evt.fileWarnings } : {}),
      ...(evt.errorMessage ? { errorMessage: evt.errorMessage } : {}),
      ...(evt.duplicateReason ? { duplicateReason: evt.duplicateReason } : {}),
      ...(evt.existingBookId ? { existingBookId: evt.existingBookId } : {}),
      progress: `${evt.processed}/${evt.discovered}`,
    },
  });
  /* Дополнительно эмитим каждую строку fileWarnings как отдельную запись
     `file.warning`. Это даёт пользователю ленту вида:
       file.added    | "OK: 5/42 (book.pdf)"
       file.warning  | "isbn-meta: lookup failed for 9785..."
       file.warning  | "vision-meta: low confidence (0.32)"
     вместо «added: 5/42» с скрытыми деталями в JSON. */
  if (evt.fileWarnings && evt.fileWarnings.length > 0) {
    for (const w of evt.fileWarnings) {
      await logger.write({
        importId,
        level: "warn",
        category: "file.warning",
        message: w,
        file: evt.currentFile,
      });
    }
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
      if (!args || typeof args !== "object") throw new Error("args required");
      const folder = parseOrThrow(AbsoluteFilePathSchema, args.folder, "folder");
      const importId = randomUUID();
      const ctrl = new AbortController();
      activeImports.set(importId, ctrl);
      const t0 = Date.now();
      const logger = getImportLogger();
      const logFile = await logger.startSession(importId);
      const prefs = await readImportPrefs();
      await logger.write({
        importId, level: "info", category: "import.start",
        message: `Importing folder ${folder}`,
        details: {
          folder, scanArchives: args.scanArchives === true, ocrEnabled: args.ocrEnabled === true, maxDepth: args.maxDepth, logFile,
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
          metadataOnlineLookup: prefs.metadataOnlineLookup,
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
        const result = await importFolderToLibrary(folder, opts);
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
      if (!args || typeof args !== "object") throw new Error("args required");
      const paths = parseOrThrow(LibraryImportFilePathsSchema, args.paths, "paths");
      if (paths.length === 0) throw new Error("paths required");
      const importId = randomUUID();
      const ctrl = new AbortController();
      activeImports.set(importId, ctrl);
      const logger = getImportLogger();
      const logFile = await logger.startSession(importId);
      const prefs = await readImportPrefs();
      await logger.write({
        importId, level: "info", category: "import.start",
        message: `Importing ${paths.length} files`,
        details: {
          fileCount: paths.length, scanArchives: args.scanArchives === true, ocrEnabled: args.ocrEnabled === true, logFile,
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
        for (let i = 0; i < paths.length; i++) {
          if (ctrl.signal.aborted) break;
          const p = paths[i];
          try {
            const itemResults = await importFiles(p, {
              scanArchives: args.scanArchives === true,
              ocrEnabled: args.ocrEnabled === true,
              signal: ctrl.signal,
              djvuOcrProvider: prefs.djvuOcrProvider,
              ocrLanguages: prefs.ocrLanguages,
              visionMetaEnabled: prefs.visionMetaEnabled,
              visionModelKey: prefs.visionModelKey,
              metadataOnlineLookup: prefs.metadataOnlineLookup,
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
            /* Сводим warnings и первую ошибку из batch в одно прогресс-событие.
               Без этого `mirrorProgressToLogger` для items-import видел только
               outcome без причин — лог-панель оставалась немой. */
            const firstFailure = itemResults.find((r) => r.outcome === "failed" || r.outcome === "skipped");
            const aggregatedWarnings: string[] = [];
            for (const r of itemResults) aggregatedWarnings.push(...r.warnings);
            broadcastImportProgress(getMainWindow, importId, {
              phase: "processed",
              discovered: paths.length,
              processed: i + 1,
              currentFile: p,
              outcome: itemResults[0]?.outcome ?? "failed",
              duplicateReason: itemResults[0]?.duplicateReason,
              existingBookId: itemResults[0]?.existingBookId,
              existingBookTitle: itemResults[0]?.existingBookTitle,
              errorMessage: firstFailure?.error ?? undefined,
              fileWarnings: aggregatedWarnings.length > 0 ? aggregatedWarnings : undefined,
              index: i + 1,
              total: paths.length,
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
              discovered: paths.length,
              processed: i + 1,
              currentFile: p,
              outcome: "failed",
              errorMessage: msg,
              index: i + 1,
              total: paths.length,
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

  ipcMain.handle("library:tag-stats", (_e, locale?: string): { tag: string; count: number }[] => {
    const loc = locale === "ru" ? "ru" : "en";
    return queryTagStats(loc);
  });

  ipcMain.handle("library:collection-by-domain", (): CollectionGroup[] => {
    return queryByDomain();
  });

  ipcMain.handle("library:collection-by-author", (_e, locale?: string): CollectionGroup[] => {
    const loc = locale === "ru" ? "ru" : "en";
    return queryByAuthor(loc);
  });

  ipcMain.handle("library:collection-by-year", (): CollectionGroup[] => {
    return queryByYear();
  });

  ipcMain.handle("library:collection-by-sphere", (): CollectionGroup[] => {
    return queryBySphere();
  });

  ipcMain.handle("library:collection-by-tag", (_e, locale?: string): CollectionGroup[] => {
    const loc = locale === "ru" ? "ru" : "en";
    return queryByTag(loc);
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
      if (!resolveLibraryRoot()) {
        return { scanned: 0, ingested: 0, skipped: 0, pruned: 0, errors: ["library root not configured — set it in Settings first"] };
      }
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

  // ── Pre-import scan ────────────────────────────────────────────────────────

  const activeScans = new Map<string, AbortController>();

  ipcMain.handle(
    "library:scan-folder",
    async (_e, args: { folder: string }): Promise<{ scanId: string }> => {
      if (!args || typeof args !== "object") throw new Error("args required");
      const folder = parseOrThrow(AbsoluteFilePathSchema, args.folder, "folder");
      const scanId = randomUUID();
      const ctrl = new AbortController();
      activeScans.set(scanId, ctrl);

      scanFolder(folder, {
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
