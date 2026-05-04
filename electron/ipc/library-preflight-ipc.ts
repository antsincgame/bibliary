/**
 * IPC handler'ы для preflight-скана перед импортом.
 *
 * Каналы:
 *   library:preflight-folder    — анализ папки до импорта
 *   library:preflight-files     — анализ списка файлов до импорта
 *   library:cancel-preflight    — отмена текущего preflight (renderer cancel-кнопка)
 *
 * Push events:
 *   library:preflight-progress  — стрим этапов (walking/probing/ocr/evaluator/complete)
 *
 * Renderer на основании отчёта показывает summary block с действиями
 * [Continue all] [Skip image-only] [Configure OCR] [Cancel].
 */

import { ipcMain, BrowserWindow } from "electron";
import {
  preflightFolder,
  preflightFiles,
  peekFolderFiles,
  type PreflightReport,
  type PreflightProgressEvent,
  type FolderPeekResult,
} from "../lib/library/preflight.js";
import { AbsoluteFilePathSchema, LibraryImportFilePathsSchema, parseOrThrow } from "./validators.js";
import { getImportLogger } from "../lib/library/import-logger.js";

const PREFLIGHT_PROGRESS_CHANNEL = "library:preflight-progress";

/**
 * Активные preflight-сессии. Один пользователь = одна сессия в каждый момент,
 * но защищаемся от race на случай быстрых retries.
 */
const activePreflights = new Map<string, AbortController>();
let preflightSeq = 0;

function broadcastPreflightProgress(sessionId: string, evt: PreflightProgressEvent): void {
  const payload = { sessionId, ...evt };
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(PREFLIGHT_PROGRESS_CHANNEL, payload);
    } catch {
      /* dead window — ignore */
    }
  }
}

function logPreflightProgress(sessionId: string, evt: PreflightProgressEvent): void {
  const logger = getImportLogger();
  const level = evt.status === "timeout" || evt.status === "failed" ? "warn" : "info";
  void logger.write({
    level,
    category: "scan.discovered",
    importId: sessionId,
    message: `[preflight:${evt.phase}] ${evt.message ?? ""} ${evt.current ?? ""}${evt.total ? `/${evt.total}` : ""}`.trim(),
    file: evt.currentPath,
    details: { phase: evt.phase, status: evt.status, current: evt.current, total: evt.total },
  });
}

export function registerLibraryPreflightIpc(): void {
  ipcMain.handle(
    "library:preflight-folder",
    async (
      _e,
      args: { folder: string; recursive?: boolean },
    ): Promise<PreflightReport> => {
      const folder = parseOrThrow(AbsoluteFilePathSchema, args.folder, "library:preflight-folder.folder");
      preflightSeq += 1;
      const sessionId = `pf-${Date.now()}-${preflightSeq}`;
      const ctrl = new AbortController();
      activePreflights.set(sessionId, ctrl);
      try {
        return await preflightFolder(folder, {
          recursive: args.recursive ?? true,
          signal: ctrl.signal,
          onProgress: (evt) => {
            broadcastPreflightProgress(sessionId, evt);
            logPreflightProgress(sessionId, evt);
          },
        });
      } finally {
        activePreflights.delete(sessionId);
      }
    },
  );

  ipcMain.handle(
    "library:preflight-files",
    async (_e, args: { paths: string[] }): Promise<PreflightReport> => {
      const paths = parseOrThrow(LibraryImportFilePathsSchema, args.paths, "library:preflight-files.paths");
      preflightSeq += 1;
      const sessionId = `pf-${Date.now()}-${preflightSeq}`;
      const ctrl = new AbortController();
      activePreflights.set(sessionId, ctrl);
      try {
        return await preflightFiles(paths, {
          signal: ctrl.signal,
          onProgress: (evt) => {
            broadcastPreflightProgress(sessionId, evt);
            logPreflightProgress(sessionId, evt);
          },
        });
      } finally {
        activePreflights.delete(sessionId);
      }
    },
  );

  ipcMain.handle("library:cancel-preflight", async (): Promise<number> => {
    let aborted = 0;
    for (const [, ctrl] of activePreflights) {
      try { ctrl.abort(); aborted++; } catch { /* tolerate */ }
    }
    activePreflights.clear();
    return aborted;
  });

  ipcMain.handle(
    "library:peek-folder",
    async (_e, args: { folder: string; recursive?: boolean }): Promise<FolderPeekResult> => {
      const folder = parseOrThrow(AbsoluteFilePathSchema, args.folder, "library:peek-folder.folder");
      return await peekFolderFiles(folder, { recursive: args.recursive ?? true });
    },
  );
}
