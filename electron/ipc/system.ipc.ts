import { ipcMain, shell } from "electron";
import { detectHardware } from "../lib/hardware/profiler.js";
import { getEndpoints } from "../lib/endpoints/index.js";
import { getServerStatus } from "../lmstudio-client.js";
import { QDRANT_URL, QDRANT_API_KEY } from "../lib/qdrant/http-client.js";

/**
 * Whitelist схем для system:open-external. Защита от prompt-injection /
 * UI бага, который мог бы открыть file:// или javascript: URL.
 * lmstudio:// — protocol handler LM Studio; http(s) — браузер.
 */
const ALLOWED_OPEN_SCHEMES = ["http:", "https:", "lmstudio:"];

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

  /**
   * A4 (welcome wizard helper): открыть внешний URL в системном браузере /
   * протокол-хэндлере. Используется wizard'ом для кнопки "Open LM Studio"
   * и потенциально другими местами, где нужно увести пользователя из
   * Bibliary без копирования URL вручную.
   * Защита: только http(s) и lmstudio:// схемы. Всё остальное игнорируется.
   */
  ipcMain.handle("system:open-external", async (_e, url: unknown): Promise<{ ok: boolean; reason?: string }> => {
    if (typeof url !== "string" || url.length === 0) {
      return { ok: false, reason: "url required" };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: "invalid url" };
    }
    if (!ALLOWED_OPEN_SCHEMES.includes(parsed.protocol)) {
      return { ok: false, reason: `scheme not allowed: ${parsed.protocol}` };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  });
}
