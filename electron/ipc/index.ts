/**
 * Единая точка регистрации IPC-handlers.
 */

import type { BrowserWindow } from "electron";

import { registerQdrantIpc } from "./qdrant.ipc.js";
import { registerLmstudioIpc } from "./lmstudio.ipc.js";
import { registerSystemIpc } from "./system.ipc.js";
import { registerScannerIpc, abortAllIngests } from "./scanner.ipc.js";
import { registerDatasetV2Ipc, abortAllDatasetV2 } from "./dataset-v2.ipc.js";
import { registerDatasetsIpc } from "./datasets.ipc.js";
import { registerPreferencesIpc } from "./preferences.ipc.js";
import { registerModelRolesIpc } from "./model-roles.ipc.js";
import { registerArenaIpc } from "./arena.ipc.js";
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
 * Регистрирует ВСЕ IPC-handlers с изоляцией ошибок.
 *
 * КРИТИЧНО: если регистрация одного handler-набора (например arena) бросает
 * exception на top-level, остальные ДОЛЖНЫ продолжить регистрацию. Иначе один
 * сломанный модуль валит весь UI приложения (см. инцидент 30 апр 2026:
 * после рефакторинга olympics.ts падал arena.ipc → library.ipc не успевал
 * зарегистрироваться → раздел "Библиотека" мёртв, UI-клики не реагируют).
 *
 * Каждый сбой логируется с контекстом — для post-mortem диагностики через
 * stderr приложения (видно в DevTools console + main process log).
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

  safeRegister("qdrant", () => registerQdrantIpc());
  safeRegister("lmstudio", () => registerLmstudioIpc());
  safeRegister("system", () => registerSystemIpc());
  safeRegister("scanner", () => registerScannerIpc(getMainWindow));
  safeRegister("dataset-v2", () => registerDatasetV2Ipc(getMainWindow));
  safeRegister("datasets", () => registerDatasetsIpc(getMainWindow));
  safeRegister("preferences", () => registerPreferencesIpc());
  safeRegister("model-roles", () => registerModelRolesIpc());
  safeRegister("arena", () => registerArenaIpc());
  safeRegister("library", () => registerLibraryIpc(getMainWindow));
}
