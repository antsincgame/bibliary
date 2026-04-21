import { ipcMain } from "electron";
import { detectHardware, clearHardwareCache } from "../lib/hardware/profiler.js";
import hardwarePresetsRaw from "../defaults/hardware-presets.json";

export function registerSystemIpc(): void {
  ipcMain.handle("system:hardware-info", async (_e, opts?: { force?: boolean }) => {
    return detectHardware({ force: opts?.force === true });
  });

  ipcMain.handle("system:env-summary", async () => {
    return {
      lmStudioUrl: process.env.LM_STUDIO_URL || "http://localhost:1234",
      qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
      platform: process.platform,
      arch: process.arch,
    };
  });

  ipcMain.handle("system:hardware-presets", async () => hardwarePresetsRaw);

  ipcMain.handle("system:invalidate-hardware-cache", async () => {
    clearHardwareCache();
    return true;
  });
}
