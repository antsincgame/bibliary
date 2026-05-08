/**
 * Единая точка регистрации IPC-handlers.
 */

import type { BrowserWindow } from "electron";

import { registerChromaIpc } from "./chroma.ipc.js";
import { registerLmstudioIpc } from "./lmstudio.ipc.js";
import { registerSystemIpc } from "./system.ipc.js";
import { registerScannerIpc, abortAllIngests } from "./scanner.ipc.js";
import { registerDatasetV2Ipc, abortAllDatasetV2 } from "./dataset-v2.ipc.js";
import { registerDatasetsIpc } from "./datasets.ipc.js";
import { registerPreferencesIpc } from "./preferences.ipc.js";
import {
  registerLibraryIpc,
  abortAllLibrary,
  activeLibraryImportCount,
  flushLibraryImports,
  bootstrapLibrarySubsystem,
} from "./library.ipc.js";

export {
  abortAllIngests,
  abortAllDatasetV2,
  abortAllLibrary,
  activeLibraryImportCount,
  flushLibraryImports,
  bootstrapLibrarySubsystem,
};

/**
 * Регистрирует ВСЕ IPC-handlers с изоляцией ошибок: сбой регистрации одного
 * набора не блокирует остальные. Каждый сбой логируется в stderr.
 */
export function registerAllIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  const safeRegister = (name: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      console.error(`[ipc/index] FAILED to register "${name}" — остальные handlers продолжат регистрацию.`, msg);
    }
  };

  safeRegister("chroma", () => registerChromaIpc());
  safeRegister("lmstudio", () => registerLmstudioIpc());
  safeRegister("system", () => registerSystemIpc());
  safeRegister("scanner", () => registerScannerIpc(getMainWindow));
  safeRegister("dataset-v2", () => registerDatasetV2Ipc(getMainWindow));
  safeRegister("datasets", () => registerDatasetsIpc(getMainWindow));
  safeRegister("preferences", () => registerPreferencesIpc());
  safeRegister("library", () => registerLibraryIpc(getMainWindow));
}
