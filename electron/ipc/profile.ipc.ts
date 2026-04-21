import { ipcMain, dialog, type BrowserWindow } from "electron";
import { getProfileStore, ProfileSchema, type Profile } from "../lib/profiles/store.js";
import { exportBibliaryProfile, importBibliaryProfile } from "../lib/profiles/bibliary-profile.js";

export function registerProfileIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("profile:list", async (): Promise<Profile[]> => {
    return getProfileStore().readAll();
  });

  ipcMain.handle("profile:get", async (_e, id: string): Promise<Profile | null> => {
    return getProfileStore().getById(id);
  });

  ipcMain.handle("profile:upsert", async (_e, raw: unknown): Promise<Profile> => {
    const validated = ProfileSchema.parse(raw);
    await getProfileStore().upsert(validated);
    return validated;
  });

  ipcMain.handle("profile:remove", async (_e, id: string): Promise<boolean> => {
    await getProfileStore().remove(id);
    return true;
  });

  ipcMain.handle("profile:reset-to-defaults", async (): Promise<Profile[]> => {
    await getProfileStore().resetToDefaults();
    return getProfileStore().readAll();
  });

  ipcMain.handle("profile:export", async (): Promise<{ path: string } | null> => {
    const win = getMainWindow();
    const result = await dialog.showSaveDialog(win || (undefined as never), {
      title: "Export Bibliary profile",
      defaultPath: `bibliary-profile-${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await exportBibliaryProfile(result.filePath);
    return { path: result.filePath };
  });

  ipcMain.handle("profile:import", async (): Promise<{ path: string; summary: unknown } | null> => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win || (undefined as never), {
      title: "Import Bibliary profile",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const file = result.filePaths[0];
    const summary = await importBibliaryProfile(file);
    return { path: file, summary };
  });
}
