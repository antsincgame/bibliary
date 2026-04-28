/**
 * Единая точка регистрации IPC-handlers.
 */

import type { BrowserWindow } from "electron";

import { registerQdrantIpc } from "./qdrant.ipc.js";
import { registerLmstudioIpc } from "./lmstudio.ipc.js";
import { registerSystemIpc } from "./system.ipc.js";
import { registerScannerIpc, abortAllIngests } from "./scanner.ipc.js";
import { registerDatasetV2Ipc, abortAllDatasetV2 } from "./dataset-v2.ipc.js";
import { registerBookhunterIpc, abortAllBookhunter } from "./bookhunter.ipc.js";
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
  abortAllBookhunter,
  abortAllLibrary,
  activeLibraryImportCount,
  flushLibraryImports,
  bootstrapLibrarySubsystem,
};

export function registerAllIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  registerQdrantIpc();
  registerLmstudioIpc();
  registerSystemIpc();
  registerScannerIpc(getMainWindow);
  registerDatasetV2Ipc(getMainWindow);
  registerBookhunterIpc(getMainWindow);
  registerPreferencesIpc();
  registerModelRolesIpc();
  registerArenaIpc();
  registerLibraryIpc(getMainWindow);
}
