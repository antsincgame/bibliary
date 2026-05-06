import { execFileSync } from "node:child_process";
import * as path from "node:path";

export interface AppDataDirContext {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  execPath: string;
  appName: string;
  devBaseDir: string;
  platform?: NodeJS.Platform;
  parentExecutablePath?: string | null;
  /**
   * Electron app.getPath("userData") — platform-appropriate user data
   * directory. Required on macOS packaged builds where execPath is inside
   * the read-only .app bundle (Contents/MacOS/). Passed from main.ts.
   */
  userDataPath?: string;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "");
}

function isLikelySameAppExecutable(exePath: string, appName: string): boolean {
  const base = normalizeName(path.basename(exePath, path.extname(exePath)));
  const app = normalizeName(appName);
  if (app.length > 0 && base.includes(app)) return true;
  return base.includes("bibliary");
}

export function getWindowsParentExecutablePath(parentPid = process.ppid): string | null {
  /* Hard guard: powershell.exe доступен только на Windows. На macOS/Linux
     spawn упадёт ENOENT — возвращаем null чтобы caller просто перешёл к
     обычному execPath fallback. */
  if (process.platform !== "win32") return null;
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  try {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${parentPid}").ExecutablePath`;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 2500, windowsHide: true },
    );
    const exePath = out.trim();
    return exePath.length > 0 ? exePath : null;
  } catch {
    return null;
  }
}

export function resolveAppDataDir(ctx: AppDataDirContext): string {
  const fromEnv = ctx.env.BIBLIARY_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  const portableDir = ctx.env.PORTABLE_EXECUTABLE_DIR?.trim();
  if (portableDir) return path.join(path.resolve(portableDir), "data");

  const portableFile = ctx.env.PORTABLE_EXECUTABLE_FILE?.trim();
  if (portableFile) return path.join(path.dirname(path.resolve(portableFile)), "data");

  const platform = ctx.platform ?? process.platform;
  if (ctx.isPackaged && platform === "win32") {
    const parentExe = ctx.parentExecutablePath?.trim();
    if (parentExe && path.resolve(parentExe) !== path.resolve(ctx.execPath) && isLikelySameAppExecutable(parentExe, ctx.appName)) {
      return path.join(path.dirname(path.resolve(parentExe)), "data");
    }
  }

  if (ctx.isPackaged) {
    /* macOS: execPath lives inside the read-only .app bundle
       (Contents/MacOS/Bibliary). Writing data there fails after code-signing.
       Use ~/Library/Application Support/<AppName> instead, which is what
       Electron's app.getPath("userData") already resolves to on macOS. */
    if (platform === "darwin" && ctx.userDataPath) {
      return path.join(ctx.userDataPath, "data");
    }
    return path.join(path.dirname(ctx.execPath), "data");
  }
  return path.resolve(ctx.devBaseDir, "..", "data");
}

