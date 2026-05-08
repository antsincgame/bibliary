/**
 * Shared state + lifecycle для library IPC.
 *
 * Извлечено из `library.ipc.ts` (Phase 3.1 cross-platform roadmap, 2026-04-30).
 * Содержит:
 *   - registry активных импортов (используется import + lifecycle handlers)
 *   - readImportPrefs (общий для всех import-handler'ов)
 *   - broadcastImportProgress + mirrorProgressToLogger
 *   - broadcastImportLog + ensureImportLogBridge
 *   - registerLibraryLlmLockProbes (probe для arena scheduler)
 *   - bootstrapLibrarySubsystem / flushLibraryImports / abortAllLibrary /
 *     activeLibraryImportCount — экспортируются из library.ipc.ts barrel.
 *
 * Здесь — никаких `ipcMain.handle`. IPC-handler'ы живут в трёх соседних
 * файлах: library-import-ipc.ts / library-catalog-ipc.ts /
 * library-evaluator-ipc.ts.
 */

import type { BrowserWindow } from "electron";
import * as path from "path";
import {
  ensureEvaluatorBootstrap,
  pauseEvaluator,
  clearQueue,
  cancelCurrentEvaluation,
  subscribeEvaluator,
  activeSlotCount as evaluatorActiveSlotCount,
} from "../lib/library/evaluator-queue.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import {
  getImportLogger,
  type ImportLogEntry,
  type ImportLogCategory,
  type ImportLogLevel,
} from "../lib/library/import-logger.js";
import { getPreferencesStore } from "../lib/preferences/store.js";
import type { ProgressEvent } from "../lib/library/import.js";

/**
 * Читает relevant prefs для импорта. Безопасно — если store не инициализирован
 * (например в тесте), возвращает дефолты, не throw.
 *
 * Vision-OCR и Vision-meta используют ИСКЛЮЧИТЕЛЬНО локальную LM Studio
 * (через роли vision_ocr / vision_meta из настроек "Модели"). Никаких облачных
 * API. Если в LM Studio нет vision-модели — graceful fallback на system OCR.
 */
export async function readImportPrefs(): Promise<{
  djvuOcrProvider: "auto" | "system" | "vision-llm" | "none";
  ocrLanguages: string[];
  ocrEnabled: boolean;
  ocrAccuracy: "fast" | "accurate";
  ocrPdfDpi: number;
  djvuRenderDpi: number;
  visionOcrModel?: string;
  metadataOnlineLookup: boolean;
}> {
  try {
    const store = getPreferencesStore();
    const prefs = await store.getAll();
    return {
      djvuOcrProvider: prefs.djvuOcrProvider,
      ocrLanguages: prefs.ocrLanguages ?? [],
      ocrEnabled: prefs.ocrEnabled !== false,
      ocrAccuracy: prefs.ocrAccuracy,
      ocrPdfDpi: prefs.ocrPdfDpi,
      djvuRenderDpi: prefs.djvuRenderDpi,
      visionOcrModel: prefs.visionOcrModel?.trim() || undefined,
      metadataOnlineLookup: prefs.metadataOnlineLookup !== false,
    };
  } catch {
    return {
      djvuOcrProvider: "auto",
      ocrLanguages: ["ru", "uk", "en"],
      ocrEnabled: true,
      ocrAccuracy: "accurate",
      ocrPdfDpi: 400,
      djvuRenderDpi: 400,
      visionOcrModel: undefined,
      metadataOnlineLookup: true,
    };
  }
}

export const SUPPORTED_FILE_FILTERS = [
  { name: "Books", extensions: ["pdf", "epub", "fb2", "docx", "doc", "rtf", "odt", "html", "htm", "txt", "djvu"] },
  { name: "Archives (will be unpacked)", extensions: ["zip", "cbz", "rar", "cbr", "7z"] },
  { name: "All files", extensions: ["*"] },
];

/**
 * Registry активных импортов. Mutable shared state между handler'ами импорта,
 * lifecycle и `cancel-import`.
 */
export const activeImports = new Map<string, AbortController>();

let evaluatorBridgeInstalled = false;
let importLogBridgeInstalled = false;
let llmLockProbesRegistered = false;

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
  const logger = getImportLogger();

  if (activeImports.size > 0) {
    for (const [, ctrl] of activeImports.entries()) ctrl.abort(reason);
  }

  const startedAt = Date.now();
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

  /* refactor 1.0.22: illustration feature удалён — drain больше не нужен. */

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
        try {
          win.webContents.send("library:evaluator-event", evt);
        } catch (err) {
          console.error("[library-ipc-state] evaluator-event send failed:", err);
        }
      }
    });
  }
  ensureImportLogBridge(getMainWindow);
  registerLibraryLlmLockProbes();
  void ensureEvaluatorBootstrap();

  /* v1.0.2: one-shot startup purge of dead imports (incomplete-torrent files
     that slipped through before file-validity guard existed). Runs in the
     background after evaluator bootstrap; non-blocking, idempotent. Result
     broadcast via `library:purge-progress` so UI can show a toast. */
  void runStartupPurgeOnce(getMainWindow);
}

let startupPurgeRan = false;
async function runStartupPurgeOnce(getMainWindow: () => BrowserWindow | null): Promise<void> {
  if (startupPurgeRan) return;
  startupPurgeRan = true;
  try {
    const { purgeDeadImports } = await import("../lib/library/dead-import-purger.js");
    const t0 = Date.now();
    const result = await purgeDeadImports({});
    const elapsedMs = Date.now() - t0;
    if (result.purged > 0 || result.missing > 0) {
      console.warn(`[startup-purge] removed ${result.purged} dead imports, ${result.missing} missing-file rows, freed ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB in ${elapsedMs}ms`);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send("library:purge-progress", { phase: "done", ...result, elapsedMs });
        } catch {
          /* swallow */
        }
      }
    }
  } catch (err) {
    console.warn("[startup-purge] failed (non-fatal):", (err as Error).message);
  }
}

/**
 * Регистрирует два probe в GlobalLlmLock — для library import и evaluator queue.
 * Они нужны Arena scheduler'у чтобы НЕ запускать калибровку пока LM Studio
 * занята массовым импортом или фоновым evaluator (защита от OOM).
 *
 * Идемпотентно: повторный вызов не дублирует probes.
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

export function broadcastImportProgress(getMainWindow: () => BrowserWindow | null, importId: string, evt: ProgressEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("library:import-progress", { importId, ...evt });
  }
  /* Зеркалим в logger как структурированное событие. Это даёт persistent
     audit trail в data/logs/import-*.jsonl, не зависящий от того, открыт ли UI. */
  void mirrorProgressToLogger(importId, evt);
}

export function broadcastImportLog(getMainWindow: () => BrowserWindow | null, entry: ImportLogEntry): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("library:import-log", entry);
  }
}

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
  if (evt.phase === "file-start") {
    await logger.write({
      importId,
      level: "info",
      category: "file.start",
      message: `Processing: ${evt.currentFile ? path.basename(evt.currentFile) : "unknown file"}`,
      file: evt.currentFile,
      details: { progress: `${evt.processed}/${evt.discovered}` },
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
  /* Iter 13.2 (2026-05-03): warnings уже включены в details.warnings выше.
     Раньше для КАЖДОГО warning дополнительно эмитился отдельный
     `file.warning` event — это создавало 5–7-кратное дублирование лога
     (на книгу с 5 warnings: 1 file.added + 5 file.warning = 6 строк).
     UI разворачивает details через ▸ expand-toggle — warnings видны.
     Counter "warn" больше не показывает routine diagnostic messages
     (типа `pdf-inspector: Mixed`), что семантически правильно: эти
     сообщения — диагностика, не настоящие warnings.
     User отчёт логов от 2026-05-03 показал шум 5-7× expected. */
}
