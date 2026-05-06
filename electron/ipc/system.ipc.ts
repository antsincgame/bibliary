import { ipcMain, shell, app } from "electron";
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import * as path from "node:path";
import { detectHardware } from "../lib/hardware/profiler.js";
import { getEndpoints } from "../lib/endpoints/index.js";
import { getServerStatus } from "../lmstudio-client.js";
import { CHROMA_URL, CHROMA_API_KEY, chromaUrl } from "../lib/chroma/http-client.js";

interface AppBuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
  electron: string;
  isPackaged: boolean;
}

let cachedBuildInfo: AppBuildInfo | null = null;

function readCommitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      windowsHide: true,
      timeout: 1500,
    }).trim() || null;
  } catch {
    return null;
  }
}

function readBuiltAt(): string | null {
  try {
    const mainPath = path.join(__dirname, "main.js");
    return statSync(mainPath).mtime.toISOString();
  } catch {
    return null;
  }
}

function getBuildInfo(): AppBuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo;
  cachedBuildInfo = {
    version: app.getVersion(),
    commit: readCommitSha(),
    builtAt: readBuiltAt(),
    electron: process.versions.electron ?? "",
    isPackaged: app.isPackaged,
  };
  return cachedBuildInfo;
}

/**
 * Whitelist схем для system:open-external. Защита от prompt-injection /
 * UI бага, который мог бы открыть file:// или javascript: URL.
 * lmstudio:// — protocol handler LM Studio; http(s) — браузер.
 */
const ALLOWED_OPEN_SCHEMES = ["http:", "https:", "lmstudio:"];

/**
 * Лёгкий ping Chroma для onboarding wizard. Heartbeat + version параллельно.
 * Короткий timeout 3s — wizard должен реагировать быстро на offline server.
 */
async function probeChroma(): Promise<{ online: boolean; version?: string; url: string }> {
  const url = CHROMA_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const headers: Record<string, string> = {};
    if (CHROMA_API_KEY) headers["X-Chroma-Token"] = CHROMA_API_KEY;
    const heartbeatResp = await fetch(chromaUrl("/heartbeat"), { signal: ctrl.signal, headers });
    if (!heartbeatResp.ok) return { online: false, url };
    /* version endpoint опционален — heartbeat=200 уже означает online. */
    let version: string | undefined;
    try {
      const verResp = await fetch(chromaUrl("/version"), { signal: ctrl.signal, headers });
      if (verResp.ok) {
        const v = await verResp.json().catch(() => null);
        if (typeof v === "string") version = v;
        else if (v && typeof v === "object" && typeof (v as { version?: string }).version === "string") {
          version = (v as { version: string }).version;
        }
      }
    } catch { /* version optional */ }
    return { online: true, version, url };
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

  ipcMain.handle("system:app-version", (): AppBuildInfo => getBuildInfo());

  /**
   * Параллельный health-check обоих внешних сервисов для onboarding wizard.
   * Один round-trip из renderer вместо двух отдельных IPC.
   * Promise.all → оба пинга параллельно, общий таймаут ~3s.
   */
  ipcMain.handle(
    "system:probe-services",
    async (): Promise<{
      lmStudio: { online: boolean; version?: string; url: string };
      chroma: { online: boolean; version?: string; url: string };
    }> => {
      const { lmStudioUrl } = await getEndpoints();
      const [lmStatus, chromaStatus] = await Promise.all([
        getServerStatus(),
        probeChroma(),
      ]);
      return {
        lmStudio: { ...lmStatus, url: lmStudioUrl },
        chroma: chromaStatus,
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
