/**
 * IPC handler'ы для preflight-скана перед импортом.
 *
 * Каналы:
 *   library:preflight-folder  — анализ папки до импорта
 *   library:preflight-files   — анализ списка файлов до импорта
 *
 * Возвращают `PreflightReport` с разбивкой:
 *  - сколько файлов с text-layer'ом (импортируются быстро)
 *  - сколько image-only сканов (требуют OCR)
 *  - готовность OCR-движков (system OCR, vision-LLM)
 *
 * Renderer на основании отчёта показывает summary block с действиями
 * [Continue all] [Skip image-only] [Configure OCR] [Cancel].
 */

import { ipcMain } from "electron";
import { preflightFolder, preflightFiles, type PreflightReport } from "../lib/library/preflight.js";
import { AbsoluteFilePathSchema, LibraryImportFilePathsSchema, parseOrThrow } from "./validators.js";

export function registerLibraryPreflightIpc(): void {
  ipcMain.handle(
    "library:preflight-folder",
    async (
      _e,
      args: { folder: string; recursive?: boolean },
    ): Promise<PreflightReport> => {
      const folder = parseOrThrow(AbsoluteFilePathSchema, args.folder, "library:preflight-folder.folder");
      return await preflightFolder(folder, {
        recursive: args.recursive ?? true,
      });
    },
  );

  ipcMain.handle(
    "library:preflight-files",
    async (_e, args: { paths: string[] }): Promise<PreflightReport> => {
      const paths = parseOrThrow(LibraryImportFilePathsSchema, args.paths, "library:preflight-files.paths");
      return await preflightFiles(paths);
    },
  );
}
