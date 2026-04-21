import { ipcMain } from "electron";
import { getPreferencesStore, DEFAULTS, type Preferences } from "../lib/preferences/store.js";

export function registerPreferencesIpc(): void {
  ipcMain.handle("preferences:get-all", async (): Promise<Preferences> => {
    return getPreferencesStore().getAll();
  });

  ipcMain.handle("preferences:get-defaults", (): Preferences => {
    return DEFAULTS;
  });

  ipcMain.handle("preferences:set", async (_e, partial: Partial<Preferences>): Promise<Preferences> => {
    if (!partial || typeof partial !== "object") throw new Error("Invalid preferences payload");
    return getPreferencesStore().set(partial);
  });

  ipcMain.handle("preferences:reset", async (): Promise<Preferences> => {
    return getPreferencesStore().reset();
  });
}
