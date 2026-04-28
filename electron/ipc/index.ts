/**
 * Phase 2.8 — единая точка регистрации IPC-handlers всех доменов.
 *
 * Один файл на домен, все exposes `registerXxxIpc(getMainWindow?)`.
 * `main.ts` вызывает только `registerAllIpcHandlers(getMainWindow)`.
 *
 * Шаблон scanner.ipc.ts → перенесён на остальные 11 доменов.
 */

import type { BrowserWindow } from "electron";

import { registerQdrantIpc } from "./qdrant.ipc.js";
import { registerLmstudioIpc } from "./lmstudio.ipc.js";
import { registerForgeIpc, abortAllForgeLocal, abortAllForgeEval } from "./forge.ipc.js";
import { registerSystemIpc } from "./system.ipc.js";
import { registerProfileIpc } from "./profile.ipc.js";
import { registerYarnIpc } from "./yarn.ipc.js";
import { registerWslIpc } from "./wsl.ipc.js";
import { registerScannerIpc, abortAllIngests } from "./scanner.ipc.js";
import { registerDatasetV2Ipc, abortAllDatasetV2 } from "./dataset-v2.ipc.js";
import { registerBookhunterIpc, abortAllBookhunter } from "./bookhunter.ipc.js";
import { registerAgentIpc, abortAllAgents } from "./agent.ipc.js";
import { registerPreferencesIpc } from "./preferences.ipc.js";
import { registerChatHistoryIpc } from "./chat-history.ipc.js";
import { registerArenaIpc } from "./arena.ipc.js";
import { registerModelRolesIpc } from "./model-roles.ipc.js";
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
  abortAllAgents,
  abortAllForgeLocal,
  abortAllForgeEval,
  abortAllLibrary,
  activeLibraryImportCount,
  flushLibraryImports,
  bootstrapLibrarySubsystem,
};

export function registerAllIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  registerQdrantIpc();
  registerLmstudioIpc();
  registerForgeIpc(getMainWindow);
  registerSystemIpc();
  registerProfileIpc(getMainWindow);
  registerYarnIpc();
  registerWslIpc();
  registerScannerIpc(getMainWindow);
  registerDatasetV2Ipc(getMainWindow);
  registerBookhunterIpc(getMainWindow);
  registerAgentIpc(getMainWindow);
  registerPreferencesIpc();
  registerChatHistoryIpc();
  registerArenaIpc();
  registerModelRolesIpc();
  registerLibraryIpc(getMainWindow);
}
