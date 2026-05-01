/**
 * Calibre CLI runtime detection + ebook-convert wrapper.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   Bibliary НЕ vendoring Calibre Portable (отличается от DjVuLibre/7zip — Calibre
 *   ~250 MB+ Python runtime + сотни DLL). Вместо этого:
 *     1. Runtime detection системного Calibre установленного через winget
 *        (`winget install --id calibre.calibre`) или official installer.
 *     2. Если найден — используем `ebook-convert.exe` для MOBI/AZW/CHM/PDB→EPUB.
 *     3. Если не найден — graceful warning «install Calibre», импорт legacy
 *        форматов недоступен (DjVu/PDF/EPUB продолжают работать).
 *
 * Зеркалит паттерн `electron/lib/scanner/parsers/djvu-cli.ts:candidateRoots()` —
 * читает из стандартных install paths (Win: `C:\Program Files\Calibre2\`,
 * `LOCALAPPDATA\Programs\Calibre2\`; macOS: `/Applications/calibre.app/Contents/MacOS`;
 * Linux: `/usr/bin`, `/opt/calibre`).
 *
 * Поддерживаемые форматы (по таблице Calibre):
 *   MOBI, AZW, AZW3, AZW4, PDB, PRC, LIT, LRF, RB, SNB, TCR, CHM, RTF
 *   → EPUB / TXT / PDF / MOBI / FB2 / DOCX / HTMLZ / ...
 *
 * Bibliary использует EPUB как target (структурированный, парсится `epubParser`).
 */

import { promises as fs } from "fs";
import * as path from "path";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";
import { platformExeName } from "../../platform.js";

const execFile = promisify(_execFile);

export interface CalibreToolResolution {
  binary: string;
  installRoot?: string;
}

/**
 * Каталоги-кандидаты где может лежать Calibre. Порядок: vendor/ override,
 * Program Files (системная установка), LOCALAPPDATA (per-user), macOS app
 * bundle, Linux package paths.
 */
function candidateRoots(): string[] {
  const roots = new Set<string>();
  const cwd = process.cwd();

  /* Override через vendor/ — если пользователь скопировал Portable Calibre сюда.
     Не дефолтная стратегия (Calibre большой), но позволяет full-portable сборку. */
  roots.add(path.join(cwd, "vendor", "calibre", "win32-x64"));
  roots.add(path.join(cwd, "vendor", "calibre"));
  if (process.resourcesPath) {
    roots.add(path.join(process.resourcesPath, "vendor", "calibre", "win32-x64"));
    roots.add(path.join(process.resourcesPath, "vendor", "calibre"));
  }

  if (process.platform === "win32") {
    /* Системная установка Calibre (winget / official installer). */
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pfx86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    roots.add(path.join(pf, "Calibre2"));
    roots.add(path.join(pfx86, "Calibre2"));
    roots.add(path.join(pf, "Calibre"));
    /* Per-user через winget --scope user. */
    const localApp = process.env["LOCALAPPDATA"] ?? "";
    if (localApp) {
      roots.add(path.join(localApp, "Programs", "Calibre2"));
      roots.add(path.join(localApp, "Programs", "Calibre"));
    }
  } else if (process.platform === "darwin") {
    roots.add("/Applications/calibre.app/Contents/MacOS");
    roots.add("/usr/local/bin");
    roots.add("/opt/homebrew/bin");
  } else {
    /* Linux. */
    roots.add("/usr/bin");
    roots.add("/usr/local/bin");
    roots.add("/opt/calibre");
  }

  return [...roots];
}

let cachedResolution: CalibreToolResolution | null | undefined = undefined;

/**
 * Найти `ebook-convert` бинарник в системе. Кеширует результат — повторные
 * вызовы не делают лишнего I/O. Возвращает `null` если Calibre не установлен.
 */
export async function resolveCalibreBinary(): Promise<CalibreToolResolution | null> {
  if (cachedResolution !== undefined) return cachedResolution;

  const exeName = platformExeName("ebook-convert");
  for (const root of candidateRoots()) {
    const full = path.join(root, exeName);
    try {
      await fs.access(full);
      cachedResolution = { binary: full, installRoot: root };
      return cachedResolution;
    } catch {
      /* try next */
    }
  }

  /* Fallback: пробуем PATH (если ebook-convert уже там, например после
     `apt install calibre` на Linux или ручная установка на Windows с PATH). */
  try {
    await execFile(exeName, ["--version"], { timeout: 3_000, windowsHide: true });
    cachedResolution = { binary: exeName };
    return cachedResolution;
  } catch {
    cachedResolution = null;
    return null;
  }
}

/**
 * Установочные подсказки если Calibre не найден — для пользовательских warnings.
 */
export function getCalibreInstallHint(): string {
  if (process.platform === "win32") {
    return "Install Calibre via `winget install --id calibre.calibre` or download from https://calibre-ebook.com/download_windows";
  }
  if (process.platform === "darwin") {
    return "Install Calibre: `brew install --cask calibre` or download from https://calibre-ebook.com/download_osx";
  }
  return "Install Calibre: `sudo apt-get install calibre` or download from https://calibre-ebook.com/download_linux";
}

export interface EbookConvertOptions {
  /** AbortSignal для отмены долгой конвертации (Calibre тяжёлых книг = десятки секунд). */
  signal?: AbortSignal;
  /** Таймаут в ms. Default: 120_000 (2 минуты — Calibre может молотить большие MOBI). */
  timeoutMs?: number;
  /**
   * Дополнительные аргументы ebook-convert (после srcPath outPath). Например:
   * `["--no-default-epub-cover"]` для пропуска дефолтной обложки EPUB.
   */
  extraArgs?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Запустить `ebook-convert srcPath outPath [extraArgs...]`.
 *
 * Caller отвечает за outPath (обычно tmpdir/.epub) и удаление после использования.
 * НЕ throw на success — возвращает stderr (Calibre часто пишет туда warnings даже при OK).
 * Throw при non-zero exit, отсутствии Calibre, таймауте, abort.
 *
 * Контракт: caller должен предварительно проверить `await resolveCalibreBinary() !== null`.
 */
export async function runEbookConvert(
  srcPath: string,
  outPath: string,
  opts: EbookConvertOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const tool = await resolveCalibreBinary();
  if (!tool) {
    throw new Error(`Calibre not found. ${getCalibreInstallHint()}`);
  }
  if (opts.signal?.aborted) throw new Error("ebook-convert aborted");

  const args = [srcPath, outPath, ...(opts.extraArgs ?? [])];
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { stdout, stderr } = await execFile(tool.binary, args, {
    signal: opts.signal,
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/**
 * Reset cached resolution — для тестов когда нужно проверить что новая
 * установка/удаление Calibre увидит обновлённое состояние.
 */
export function _resetCalibreResolutionForTests(): void {
  cachedResolution = undefined;
}
