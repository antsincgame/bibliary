import { ipcMain, shell, app } from "electron";
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { detectHardware } from "../lib/hardware/profiler.js";
import { getEndpoints } from "../lib/endpoints/index.js";
import { getServerStatus } from "../lmstudio-client.js";
import { listCollections } from "../lib/vectordb/index.js";

interface AppBuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
  electron: string;
  isPackaged: boolean;
}

interface BuildInfoFile {
  commit?: string | null;
  builtAt?: string | null;
  nodeVersion?: string;
}

let cachedBuildInfo: AppBuildInfo | null = null;
let cachedBuildInfoFile: BuildInfoFile | null | undefined = undefined;

/**
 * Читает dist-electron/build-info.json (создаётся scripts/prepare-electron.js
 * при компиляции). Кэшируется в памяти. Если файл отсутствует или
 * битый — возвращает null, caller fallback'ится.
 *
 * Это заменяет runtime `execSync("git rev-parse")` (audit 2026-05-09):
 *   - в packaged build нет .git → execSync кидал → commit всегда null;
 *   - runtime spawn shell — лишняя поверхность атаки;
 *   - 1.5s timeout каждый раз — тормозит onboarding wizard.
 */
function readBuildInfoFile(): BuildInfoFile | null {
  if (cachedBuildInfoFile !== undefined) return cachedBuildInfoFile;
  try {
    const buildInfoPath = path.join(__dirname, "build-info.json");
    const raw = readFileSync(buildInfoPath, "utf8");
    const parsed = JSON.parse(raw) as BuildInfoFile;
    cachedBuildInfoFile = parsed;
    return parsed;
  } catch {
    cachedBuildInfoFile = null;
    return null;
  }
}

function readCommitSha(): string | null {
  /* Primary path: build-info.json (записан при compile time). */
  const fromFile = readBuildInfoFile();
  if (fromFile && typeof fromFile.commit === "string" && fromFile.commit.length > 0) {
    return fromFile.commit;
  }
  /* Dev fallback: execSync git ТОЛЬКО когда не packaged. В packaged
     .git каталога нет, и runtime spawn shell — лишний риск. */
  if (app.isPackaged) return null;
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
  /* Primary path: build-info.json. */
  const fromFile = readBuildInfoFile();
  if (fromFile && typeof fromFile.builtAt === "string" && fromFile.builtAt.length > 0) {
    return fromFile.builtAt;
  }
  /* Fallback: mtime of main.js (dev mode where build-info.json missing). */
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
 * Probe для in-process LanceDB: проверяем что connection открыт и
 * можно перечислить tables. Всегда быстрый (millisecond-level), нет
 * network round-trip'ов.
 */
async function probeVectorDb(): Promise<{ online: boolean; version?: string; url: string }> {
  /* `url` пустой — embedded LanceDB не имеет network endpoint'а. */
  try {
    await listCollections();
    return { online: true, version: "lancedb-embedded", url: "" };
  } catch {
    return { online: false, url: "" };
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
      vectordb: { online: boolean; version?: string; url: string };
    }> => {
      const { lmStudioUrl } = await getEndpoints();
      const [lmStatus, vectorStatus] = await Promise.all([
        getServerStatus(),
        probeVectorDb(),
      ]);
      return {
        lmStudio: { ...lmStatus, url: lmStudioUrl },
        vectordb: vectorStatus,
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
