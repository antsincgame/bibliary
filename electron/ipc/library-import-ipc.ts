/**
 * IPC-handler'ы для импорта библиотеки + pre-import folder scan.
 *
 * Каналы:
 *   library:pick-folder
 *   library:pick-files
 *   library:import-folder
 *   library:import-files
 *   library:cancel-import
 *   library:import-log-snapshot
 *   library:scan-folder
 *   library:cancel-scan
 *
 * Push events: library:import-progress | library:import-log |
 *              library:scan-progress | library:scan-report
 *
 * Извлечено из `library.ipc.ts` (Phase 3.1 cross-platform roadmap, 2026-04-30).
 */

import { ipcMain, dialog, type BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import {
  importFolderToLibrary,
  importFile as importFiles,
  type ImportFolderOptions,
} from "../lib/library/import.js";
import {
  enqueueBook,
  pauseEvaluator,
  resumeEvaluator,
  getEvaluatorStatus,
} from "../lib/library/evaluator-queue.js";
import {
  getImportLogger,
  type ImportLogEntry,
} from "../lib/library/import-logger.js";
import {
  AbsoluteFilePathSchema,
  LibraryImportFilePathsSchema,
  parseOrThrow,
} from "./validators.js";
import { scanFolder, type ScanReport, type ScanProgressEvent } from "../lib/library/scan-folder.js";
import {
  activeImports,
  readImportPrefs,
  SUPPORTED_FILE_FILTERS,
  broadcastImportProgress,
} from "./library-ipc-state.js";

export function registerLibraryImportIpc(getMainWindow: () => BrowserWindow | null): void {
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
      /* Auto-pause evaluator при больших импортах. Audit 2026-04-30:
         параллельная работа evaluator (slotCount=2 chat) + import (4 vision-meta)
         + illustration semaphore (2×4 vision) при 100+ книгах перегружает
         LM Studio. Стратегия: первые 100 книг идут в очередь evaluator
         немедленно (low load), при 101-й книге — auto-pause; resume в finally.
         Если evaluator уже был на паузе пользователем — оставляем как есть. */
      let importedCount = 0;
      let autoPaused = false;
      const AUTO_PAUSE_THRESHOLD = 100;
      try {
        const opts: ImportFolderOptions = {
          scanArchives: args.scanArchives === true,
          /* OCR-флаг: явный override от UI или глобальный prefs.ocrEnabled. */
          ocrEnabled: typeof args.ocrEnabled === "boolean" ? args.ocrEnabled : prefs.ocrEnabled,
          maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
          djvuOcrProvider: prefs.djvuOcrProvider,
          ocrLanguages: prefs.ocrLanguages,
          ocrAccuracy: prefs.ocrAccuracy,
          ocrPdfDpi: prefs.ocrPdfDpi,
          djvuRenderDpi: prefs.djvuRenderDpi,
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
            importedCount += 1;
            enqueueBook(meta.id);
            void logger.write({
              importId, level: "info", category: "evaluator.queued",
              message: `Queued for evaluation: ${meta.titleEn || meta.title || meta.id}`,
              file: meta.originalFile,
              details: { bookId: meta.id, format: meta.originalFormat, words: meta.wordCount },
            });
            if (importedCount === AUTO_PAUSE_THRESHOLD && !autoPaused && !getEvaluatorStatus().paused) {
              autoPaused = true;
              pauseEvaluator();
              void logger.write({
                importId, level: "info", category: "evaluator.queued",
                message: `Auto-paused evaluator at ${AUTO_PAUSE_THRESHOLD} imports — will resume after import completes`,
              });
            } else if (importedCount === AUTO_PAUSE_THRESHOLD && getEvaluatorStatus().paused) {
              void logger.write({
                importId, level: "info", category: "evaluator.queued",
                message: `Evaluator was already paused at ${AUTO_PAUSE_THRESHOLD} imports — preserving user pause`,
              });
            }
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
        if (autoPaused) {
          resumeEvaluator();
          await logger.write({
            importId, level: "info", category: "evaluator.queued",
            message: `Resumed evaluator after import (${importedCount} books queued)`,
          });
        }
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
              ocrEnabled: typeof args.ocrEnabled === "boolean" ? args.ocrEnabled : prefs.ocrEnabled,
              signal: ctrl.signal,
              djvuOcrProvider: prefs.djvuOcrProvider,
              ocrLanguages: prefs.ocrLanguages,
              ocrAccuracy: prefs.ocrAccuracy,
              ocrPdfDpi: prefs.ocrPdfDpi,
              djvuRenderDpi: prefs.djvuRenderDpi,
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
              if (r.outcome === "added" && r.bookId) {
                enqueueBook(r.bookId);
                void logger.write({
                  importId, level: "info", category: "evaluator.queued",
                  message: `Queued for evaluation: ${r.meta?.titleEn || r.meta?.title || r.bookId}`,
                  file: p,
                  details: {
                    bookId: r.bookId,
                    format: r.meta?.originalFormat,
                    words: r.meta?.wordCount,
                  },
                });
              }
            }
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
    /* Не удаляем activeImports здесь: worker ещё может писать book.md/meta.json.
       Удаление делает finally в import-folder/import-files handler после
       реального завершения. */
    await getImportLogger().write({
      importId, level: "warn", category: "import.cancel",
      message: "Import cancelled by user",
    });
    return true;
  });

  /* ── Pre-import scan ──────────────────────────────────────────────── */

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
