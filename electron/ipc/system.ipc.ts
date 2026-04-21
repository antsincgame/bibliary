import { ipcMain } from "electron";
import { detectHardware, clearHardwareCache } from "../lib/hardware/profiler.js";
import hardwarePresetsRaw from "../defaults/hardware-presets.json";
import curatedModelsRaw from "../defaults/curated-models.json";
import { getEndpoints, getEndpointsSource } from "../lib/endpoints/index.js";
import { getServerStatus } from "../lmstudio-client.js";
import { QDRANT_URL, QDRANT_API_KEY } from "../lib/qdrant/http-client.js";

/**
 * Лёгкий ping Qdrant root для onboarding wizard.
 * Намеренно дублирует часть логики qdrant:cluster-info — здесь нужен только
 * online/version с коротким таймаутом, без подсчёта коллекций (быстрее, проще
 * в обработке offline кейсов wizard'ом).
 */
async function probeQdrant(): Promise<{ online: boolean; version?: string; url: string }> {
  const url = QDRANT_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const headers: Record<string, string> = {};
    if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
    const resp = await fetch(`${url}/`, { signal: ctrl.signal, headers });
    if (!resp.ok) return { online: false, url };
    const root = (await resp.json().catch(() => ({}))) as { version?: string };
    return { online: true, version: root.version, url };
  } catch {
    return { online: false, url };
  } finally {
    clearTimeout(timer);
  }
}

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

  /**
   * Кураторский список рекомендованных моделей (electron/defaults/curated-models.json).
   * Для onboarding wizard "Models"-step. Защищает от выбора мусорных квантов через
   * свободный HF-search.
   */
  ipcMain.handle("system:curated-models", async () => curatedModelsRaw);

  ipcMain.handle("system:invalidate-hardware-cache", async () => {
    clearHardwareCache();
    return true;
  });

  /**
   * Параллельный health-check обоих внешних сервисов для onboarding wizard.
   * Один round-trip из renderer вместо двух отдельных IPC.
   * Promise.all → оба пинга параллельно, общий таймаут ~3s.
   */
  ipcMain.handle(
    "system:probe-services",
    async (): Promise<{
      lmStudio: { online: boolean; version?: string; url: string };
      qdrant: { online: boolean; version?: string; url: string };
    }> => {
      const { lmStudioUrl } = await getEndpoints();
      const [lmStatus, qdrantStatus] = await Promise.all([
        getServerStatus(),
        probeQdrant(),
      ]);
      return {
        lmStudio: { ...lmStatus, url: lmStudioUrl },
        qdrant: qdrantStatus,
      };
    }
  );
}
