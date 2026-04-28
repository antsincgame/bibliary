import { ipcMain } from "electron";
import {
  listDownloaded,
  listLoaded,
  loadModel,
  unloadModel,
  getServerStatus,
} from "../lmstudio-client.js";

export function registerLmstudioIpc(): void {
  ipcMain.handle("lmstudio:status", async () => getServerStatus());
  ipcMain.handle("lmstudio:list-downloaded", async () => listDownloaded());
  ipcMain.handle("lmstudio:list-loaded", async () => listLoaded());

  ipcMain.handle(
    "lmstudio:load",
    async (_e, modelKey: string, opts: { contextLength?: number; ttlSec?: number; gpuOffload?: "max" | number } = {}) =>
      loadModel(modelKey, opts)
  );
  ipcMain.handle("lmstudio:unload", async (_e, identifier: string) => unloadModel(identifier));
}
