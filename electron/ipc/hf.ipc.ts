import { ipcMain, shell as electronShell } from "electron";
import * as path from "path";
import {
  saveHfToken,
  loadHfToken,
  clearHfToken,
  hasHfToken,
  searchModels as hfSearchModels,
  getModelInfo as hfGetModelInfo,
  buildColabUrl,
  buildAutoTrainUrl,
} from "../lib/hf/client.js";

const hfDataDir = path.resolve("data");

export function registerHfIpc(): void {
  ipcMain.handle("hf:has-token", async (): Promise<boolean> => hasHfToken(hfDataDir));

  ipcMain.handle("hf:save-token", async (_e, token: string): Promise<{ ok: true }> => {
    if (typeof token !== "string" || token.length < 4) {
      throw new Error("Invalid token");
    }
    await saveHfToken(hfDataDir, token);
    return { ok: true };
  });

  ipcMain.handle("hf:clear-token", async (): Promise<{ ok: true }> => {
    await clearHfToken(hfDataDir);
    return { ok: true };
  });

  ipcMain.handle("hf:search-models", async (_e, args: { query: string; limit?: number }) => {
    return hfSearchModels(args.query || "", args.limit || 20);
  });

  ipcMain.handle("hf:model-info", async (_e, repoId: string) => hfGetModelInfo(repoId));

  ipcMain.handle("hf:open-colab", async (): Promise<{ url: string }> => {
    const url = buildColabUrl();
    await electronShell.openExternal(url);
    return { url };
  });

  ipcMain.handle("hf:open-autotrain", async (): Promise<{ url: string }> => {
    const url = buildAutoTrainUrl();
    await electronShell.openExternal(url);
    return { url };
  });

  /* Прогружаем токен в кэш по запросу UI (ленивый init). */
  void loadHfToken;
}
