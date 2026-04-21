/**
 * WSL detector + bootstrap helper.
 *
 * Used by:
 *  - Forge wizard step 4 — enable/disable "Local WSL" target
 *  - Phase 3.3 setup wizard — "install unsloth in WSL" one-click
 *
 * Безопасно работает на Windows, на не-Windows возвращает not-installed.
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execAsync = promisify(exec);
const EXEC_TIMEOUT_MS = 5_000;

export interface WslInfo {
  installed: boolean;
  /** version: 1 | 2. null если не определено. */
  version: 1 | 2 | null;
  /** Список distros. */
  distros: string[];
  /** Default distro name. */
  defaultDistro: string | null;
  /** Доступен ли GPU passthrough (CUDA в WSL2). */
  gpuPassthrough: boolean;
}

export async function detectWSL(): Promise<WslInfo> {
  const empty: WslInfo = {
    installed: false,
    version: null,
    distros: [],
    defaultDistro: null,
    gpuPassthrough: false,
  };

  if (process.platform !== "win32") return empty;

  try {
    const { stdout } = await execAsync("wsl.exe --list --verbose", { timeout: EXEC_TIMEOUT_MS });
    // wsl --list --verbose возвращает UTF-16 LE на Windows. Часто пробелы между байтами.
    const cleaned = stdout.replace(/\u0000/g, "");
    const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    if (lines.length === 0) return empty;

    const distros: string[] = [];
    let defaultDistro: string | null = null;
    let version: 1 | 2 | null = null;

    for (const line of lines.slice(1)) {
      // "* Ubuntu  Running  2"
      const m = line.match(/^(\*?)\s*([^\s]+)\s+\S+\s+(\d)$/);
      if (!m) continue;
      const isDefault = !!m[1];
      const name = m[2];
      const v = Number(m[3]);
      distros.push(name);
      if (isDefault) defaultDistro = name;
      if (v === 1 || v === 2) version = v;
    }

    if (distros.length === 0 && /docker/i.test(cleaned)) {
      // Только docker-desktop distro — это валидно но не подходит для unsloth
      return { ...empty, installed: true };
    }

    if (distros.length === 0) return empty;

    // GPU passthrough check: nvidia-smi внутри WSL
    let gpuPassthrough = false;
    try {
      await execAsync(`wsl -d ${defaultDistro || distros[0]} -- nvidia-smi -L`, {
        timeout: EXEC_TIMEOUT_MS,
      });
      gpuPassthrough = true;
    } catch {
      gpuPassthrough = false;
    }

    return {
      installed: true,
      version: version || 2,
      distros,
      defaultDistro: defaultDistro || distros[0] || null,
      gpuPassthrough,
    };
  } catch {
    return empty;
  }
}

/**
 * Запуск bash скрипта в WSL. Используется для setup-wsl.sh и для тренировки.
 *
 * @param scriptPath абсолютный путь к .sh (внутри Windows, конвертируем в /mnt/c/...).
 * @param distro имя distro (или null = default)
 * @returns child stream
 */
export function spawnWsl(args: string[], distro?: string | null) {
  // Импорт child_process через require, чтобы не тащить spawn как top-level зависимость
  // в конструктор файла (важно для tree-shake при тестах).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require("child_process") as typeof import("child_process");
  const wslArgs = distro ? ["-d", distro, ...args] : args;
  return spawn("wsl.exe", wslArgs, { windowsHide: true });
}

/**
 * Преобразование Windows-пути в WSL-путь (`C:\foo` → `/mnt/c/foo`).
 */
export function toWslPath(winPath: string): string {
  const normalized = path.resolve(winPath);
  const driveMatch = normalized.match(/^([A-Z]):\\(.*)$/i);
  if (!driveMatch) return normalized;
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}
