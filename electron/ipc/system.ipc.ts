import { ipcMain } from "electron";
import { detectHardware, clearHardwareCache } from "../lib/hardware/profiler.js";
import hardwarePresetsRaw from "../defaults/hardware-presets.json";
import { getEndpoints, getEndpointsSource } from "../lib/endpoints/index.js";

export function registerSystemIpc(): void {
  ipcMain.handle("system:hardware-info", async (_e, opts?: { force?: boolean }) => {
    return detectHardware({ force: opts?.force === true });
  });

  ipcMain.handle("system:env-summary", async () => {
    const { lmStudioUrl, qdrantUrl } = await getEndpoints();
    return {
      lmStudioUrl,
      qdrantUrl,
      /** Where the URLs were resolved from: prefs / env / default. */
      source: getEndpointsSource(),
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
