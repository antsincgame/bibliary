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
 *   library:clear-import-logs
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
  cancelCurrentEvaluation,
  clearQueue as clearEvaluatorQueue,
  getEvaluatorStatus,
  subscribeEvaluator,
} from "../lib/library/evaluator-queue.js";
import { readPipelinePrefsOrNull } from "../lib/preferences/store.js";
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
import { beginImport as beginAdaptive, endImport as endAdaptive } from "../lib/library/adaptive-bootstrap.js";

/**
 * Auto-pause evaluator во время импорта (v0.11.13, 2026-05-04).
 *
 * Контракт:
 *   - При старте импорта: ставим evaluator на паузу (если он не был уже paused
 *     пользователем). Запоминаем флаг autoPaused для finally.
 *   - В finally: если автопауза — снимаем паузу. Если был user-pause до импорта —
 *     не трогаем (preserves user intent).
 *
 * Зачем: vision-meta + vision-illustration + evaluator (chat) = 3 параллельных
 * клиента LM Studio. На больших импортах это перегружает GPU/VRAM, модель
 * крашится с "Context size has been exceeded" / "model has crashed". Auto-pause
 * освобождает chat-слот для vision-этапов импорта; после импорта evaluator
 * подберёт ВСЕ накопленные книги и оценит их без конкуренции.
 *
 * Раньше пауза включалась только после AUTO_PAUSE_THRESHOLD=100 книг — но при
 * 50-книжных импортах LM Studio уже падала. Теперь pause = default.
 */
function autoPauseEvaluatorForImport(): { wasUserPaused: boolean; autoPaused: boolean } {
  const wasUserPaused = getEvaluatorStatus().paused;
  if (wasUserPaused) return { wasUserPaused: true, autoPaused: false };
  pauseEvaluator();
  return { wasUserPaused: false, autoPaused: true };
}

function resumeEvaluatorAfterImport(state: { wasUserPaused: boolean; autoPaused: boolean }): void {
  if (state.autoPaused) resumeEvaluator();
}

/**
 * Прокси evaluator-событий в Import Logger. Категория `evaluator.queued`
 * существовала и раньше, но started/done/failed уходили только через
 * subscribeEvaluator → renderer и НЕ попадали в JSONL-лог. Пользователь не
 * мог понять «работает evaluator или нет» по логу — отсюда жалобы вида
 * «оценщик сломан». Теперь все события видны в Import Logger.
 *
 * Подписка живёт всё время сессии импорта; при unsubscribe в finally —
 * никаких утечек. Если importId не нужен (события эвалюатора могут
 * приходить и после конца импорта), пишем под текущим importId — это даёт
 * пользователю единый «таймлайн» обработки конкретного batch'а.
 */
function attachEvaluatorLogger(importId: string, logger: ReturnType<typeof getImportLogger>): () => void {
  const unsubscribe = subscribeEvaluator((evt) => {
    /* Пропускаем queued — он уже логируется в onBookImported callback (с file path
       и format). Двойное логирование одного и того же события мусорит JSONL. */
    if (evt.type === "evaluator.queued") return;
    const lvl: "info" | "warn" = evt.type === "evaluator.failed" ? "warn" : "info";
    void logger.write({
      importId,
      level: lvl,
      category: "evaluator.queued" /* единая категория для evaluator-событий в logger */,
      message: evaluatorEventMessage(evt),
      details: {
        eventType: evt.type,
        bookId: evt.bookId,
        title: evt.title,
        qualityScore: evt.qualityScore,
        isFictionOrWater: evt.isFictionOrWater,
        warnings: evt.warnings,
        error: evt.error,
        remaining: evt.remaining,
      },
    });
  });
  return unsubscribe;
}

function evaluatorEventMessage(evt: { type: string; title?: string; qualityScore?: number; error?: string }): string {
  switch (evt.type) {
    case "evaluator.started": return `Evaluating: ${evt.title ?? "<unknown>"}`;
    case "evaluator.done": return `Evaluated: ${evt.title ?? "<unknown>"} — score ${evt.qualityScore ?? "?"}`;
    case "evaluator.failed": return `Evaluation failed: ${evt.title ?? "<unknown>"} — ${evt.error ?? "no reason"}`;
    case "evaluator.skipped": return `Evaluation skipped: ${evt.title ?? "<unknown>"}${evt.error ? ` — ${evt.error}` : ""}`;
    case "evaluator.paused": return "Evaluator paused";
    case "evaluator.resumed": return "Evaluator resumed";
    case "evaluator.idle": return "Evaluator idle (queue drained)";
    default: return `Evaluator event: ${evt.type}`;
  }
}

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
      /* Ранний heartbeat: сообщаем renderer'у importId МГНОВЕННО, до любого
         медленного await (startSession/readImportPrefs/fs.stat/walker). Без
         этого пользователь после Continue в preflight видит долгое молчание,
         если первый файл/архив обрабатывается несколько секунд. С heartbeat
         renderer гарантированно получает сигнал "main принял вызов" сразу. */
      broadcastImportProgress(getMainWindow, importId, {
        phase: "started",
        discovered: 0,
        processed: 0,
        index: 0,
        total: 0,
      });
      const logger = getImportLogger();
      const logFile = await logger.startSession(importId);
      const prefs = await readImportPrefs();
      const pipelinePrefs = await readPipelinePrefsOrNull().catch(() => null);
      /* refactor 1.0.22: detectRoleCollisions удалён (3 модели вместо 9 ролей). */
      await logger.write({
        importId, level: "info", category: "import.start",
        message: `Importing folder ${folder}`,
        details: {
          folder, scanArchives: args.scanArchives === true, ocrEnabled: args.ocrEnabled === true, maxDepth: args.maxDepth, logFile,
          djvuOcrProvider: prefs.djvuOcrProvider, ocrLanguages: prefs.ocrLanguages,
          visionOcrModel: prefs.visionOcrModel,
        },
      });
      let endStatus: "ok" | "failed" | "cancelled" = "ok";
      /* v0.11.13: Auto-pause evaluator на ВЕСЬ импорт (не после N книг).
         Раньше evaluator конкурировал с vision-meta/vision-illustration за
         LM Studio с первой же книги — это валило chat-модель ("Context size
         exceeded", "model has crashed") посреди batch'а. */
      const evaluatorPauseState = autoPauseEvaluatorForImport();
      let importedCount = 0;
      const detachEvaluatorLogger = attachEvaluatorLogger(importId, logger);
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
          
          visionOcrModel: prefs.visionOcrModel,
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
          /* Каждую новую книгу немедленно ставим в очередь оценки.
             Evaluator на паузе (autoPauseEvaluatorForImport) — книги
             накопятся и будут обработаны после конца импорта.
             v1.0.7: allowAutoLoad=true — пользователь явно нажал
             «Импорт», для новых книг разрешаем грузить preferred модель. */
          onBookImported: (meta) => {
            importedCount += 1;
            enqueueBook(meta.id, { allowAutoLoad: true });
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
        resumeEvaluatorAfterImport(evaluatorPauseState);
        if (evaluatorPauseState.autoPaused) {
          await logger.write({
            importId, level: "info", category: "evaluator.queued",
            message: `Resumed evaluator after import (${importedCount} books queued)`,
          });
        }
        detachEvaluatorLogger();
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
      /* Ранний heartbeat: см. комментарий в "library:import-folder" handler. */
      broadcastImportProgress(getMainWindow, importId, {
        phase: "started",
        discovered: paths.length,
        processed: 0,
        index: 0,
        total: paths.length,
      });
      const logger = getImportLogger();
      const logFile = await logger.startSession(importId);
      const prefs = await readImportPrefs();
      const pipelinePrefs = await readPipelinePrefsOrNull().catch(() => null);
      /* refactor 1.0.22: detectRoleCollisions удалён (3 модели вместо 9 ролей). */
      await logger.write({
        importId, level: "info", category: "import.start",
        message: `Importing ${paths.length} files`,
        details: {
          fileCount: paths.length, scanArchives: args.scanArchives === true, ocrEnabled: args.ocrEnabled === true, logFile,
          djvuOcrProvider: prefs.djvuOcrProvider, ocrLanguages: prefs.ocrLanguages,
          visionOcrModel: prefs.visionOcrModel,
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
      let adaptiveStarted = false;
      /* v0.11.13: симметрия с library:import-folder — auto-pause evaluator
         на ВЕСЬ импорт + логирование evaluator-событий в Import Logger. */
      const evaluatorPauseState = autoPauseEvaluatorForImport();
      const detachEvaluatorLogger = attachEvaluatorLogger(importId, logger);
      let importedCount = 0;
      try {
        try { await beginAdaptive(); adaptiveStarted = true; } catch { /* не блокируем импорт */ }
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
              
              visionOcrModel: prefs.visionOcrModel,
              metadataOnlineLookup: prefs.metadataOnlineLookup,
              onVisionMetaEvent,
            });
            for (const r of itemResults) {
              aggregate.total += 1;
              aggregate[r.outcome] += 1;
              aggregate.warnings.push(...r.warnings);
              /* Симметрия с folder-импортом: каждую новую книгу немедленно
                 ставим в evaluator-queue, чтобы LLM-оценка началась
                 сразу, а не в конце большого batch.
                 v1.0.7: allowAutoLoad=true — пользователь нажал «Импорт». */
              if (r.outcome === "added" && r.bookId) {
                importedCount += 1;
                enqueueBook(r.bookId, { allowAutoLoad: true });
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
        if (adaptiveStarted) endAdaptive();
        activeImports.delete(importId);
        resumeEvaluatorAfterImport(evaluatorPauseState);
        if (evaluatorPauseState.autoPaused) {
          await logger.write({
            importId, level: "info", category: "evaluator.queued",
            message: `Resumed evaluator after import (${importedCount} books queued)`,
          });
        }
        detachEvaluatorLogger();
        await logger.endSession({ status: endStatus });
      }
    }
  );

  ipcMain.handle("library:import-log-snapshot", async (): Promise<ImportLogEntry[]> => {
    const logger = getImportLogger();
    await logger.loadLastDiskSession();
    return logger.snapshot();
  });

  ipcMain.handle("library:clear-import-logs", async (): Promise<number> => {
    const logger = getImportLogger();
    return logger.clearAll();
  });

  ipcMain.handle("library:cancel-import", async (_e, importId: string): Promise<boolean> => {
    const ctrl = activeImports.get(importId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    /* Не удаляем activeImports здесь: worker ещё может писать book.md/meta.json.
       Удаление делает finally в import-folder/import-files handler после
       реального завершения. */

    /* Cancel also stops the evaluator queue to avoid orphaned LLM work after
       import abort.

       Лечение: чистим pending очередь + прерываем in-flight задачу.
       Сами очереди остаются АКТИВНЫМИ (не paused) — это важно: при
       следующем импорте новые книги начнут обрабатываться сразу, а не
       требовать ручного `resume`. Если пользователь явно паузил очередь
       раньше через UI — этот флаг pause не сбрасывается (paused-state
       сохраняется через user-explicit pause/resume IPC, а не через cancel
       import). */
    clearEvaluatorQueue();
    cancelCurrentEvaluation("import-cancelled");

    await getImportLogger().write({
      importId, level: "warn", category: "import.cancel",
      message:
        "Import aborted via cancel-import (UI). Evaluator queue cleared; in-flight LLM calls aborted. " +
        "There is no automatic cancel in code — only this IPC or app shutdown.",
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
