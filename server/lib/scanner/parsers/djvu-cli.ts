import { promises as fs } from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { platformVendorDirsWithLegacy } from "../_vendor/platform.js";
import {
  spawnWithWatchdog,
  isChildWatchdogTimeoutError,
} from "../_vendor/resilience/child-watchdog.js";
import * as telemetry from "../_vendor/resilience/telemetry.js";
import {
  getDjvuPageCountNative,
  runDjvutxtNative,
  runDjvutxtPageNative,
  isDjvuNativeAvailable,
} from "./djvu-native.js";

/**
 * Iter 14.4 (2026-05-04, /imperor): Strangler Fig переход на нативный
 * pure-JS DjVu парсер (RussCoder/djvu.js). По умолчанию используется
 * NATIVE путь; при ошибке (например bundle не нашёлся в production build) —
 * graceful fallback на DjVuLibre CLI vendored binaries.
 *
 * Контроль через env:
 *   - BIBLIARY_DJVU_FORCE_CLI=1 — принудительно использовать CLI (для отладки)
 *   - BIBLIARY_DJVU_FORCE_NATIVE=1 — принудительно native (без fallback)
 */
function shouldUseNative(): boolean {
  if (process.env.BIBLIARY_DJVU_FORCE_CLI === "1") return false;
  if (!isDjvuNativeAvailable()) return false;
  return true;
}

function shouldFallbackToCli(): boolean {
  return process.env.BIBLIARY_DJVU_FORCE_NATIVE !== "1";
}

/** Per-stage watchdog budgets. DjVuLibre #297 infinite loop в RLE decoder
 *  означает что любой stage может зависнуть. Бюджеты подобраны по нижней
 *  границе времени реальных операций + запас. */
const DJVU_TIMEOUT_DJVUTXT_FULL_MS = 60_000;
const DJVU_TIMEOUT_DJVUTXT_PAGE_MS = 15_000;
const DJVU_TIMEOUT_DJVUSED_MS = 10_000;
const DJVU_TIMEOUT_DDJVU_PAGE_MS = 90_000;
const DJVU_TIMEOUT_DDJVU_TO_PDF_MS = 180_000;

export interface DjvuToolResolution {
  binary: string;
  bundledRoot?: string;
}

function candidateRoots(): string[] {
  const roots = new Set<string>();
  const cwd = process.cwd();
  /* per-platform + legacy win32-x64 fallback (Phase 4.2). */
  for (const subdir of platformVendorDirsWithLegacy()) {
    roots.add(path.join(cwd, "vendor", "djvulibre", subdir));
  }
  roots.add(path.join(cwd, "vendor", "djvulibre"));
  if (process.platform === "win32") {
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const pf64 = process.env["ProgramFiles"] ?? "C:\\Program Files";
    for (const base of [pf86, pf64]) {
      roots.add(path.join(base, "DjVuLibre"));
      roots.add(path.join(base, "DjView"));
    }
    const localApp = process.env["LOCALAPPDATA"] ?? "";
    if (localApp) roots.add(path.join(localApp, "Programs", "DjVuLibre"));
  }
  /* Linux/macOS: типичные системные пути для CLI */
  if (process.platform !== "win32") {
    roots.add("/usr/local/bin");
    roots.add("/usr/bin");
    roots.add("/opt/homebrew/bin");
  }
  return [...roots];
}

function binaryCandidates(name: string): string[] {
  if (process.platform === "win32") return [`${name}.exe`, name];
  return [name];
}

async function locateBundledBinary(name: string): Promise<DjvuToolResolution | null> {
  for (const root of candidateRoots()) {
    for (const file of binaryCandidates(name)) {
      const full = path.join(root, file);
      try {
        await fs.access(full);
        return { binary: full, bundledRoot: root };
      } catch {
        // continue
      }
    }
  }
  return null;
}

async function resolveBinary(name: string): Promise<DjvuToolResolution> {
  const bundled = await locateBundledBinary(name);
  if (bundled) return bundled;
  return { binary: name };
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("djvu operation aborted");
}

interface DjvuRunOpts {
  signal?: AbortSignal;
  timeoutMs: number;
  watchdogName: string;
  filePath: string;
}

async function runBinary(
  binary: string,
  args: string[],
  opts: DjvuRunOpts,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  ensureNotAborted(opts.signal);
  try {
    const result = await spawnWithWatchdog(binary, args, {
      name: opts.watchdogName,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      maxStdoutBytes: 64 * 1024 * 1024,
      maxStderrBytes: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    if (isChildWatchdogTimeoutError(err)) {
      telemetry.logEvent({
        type: "child.timeout",
        name: opts.watchdogName,
        command: binary,
        elapsedMs: err.elapsedMs,
        killed: err.killed,
        exitCode: null,
        signalName: "watchdog",
      });
      throw new Error(
        `djvu watchdog: ${opts.watchdogName} hung on "${path.basename(opts.filePath)}" after ${err.elapsedMs}ms (DjVuLibre #297 infinite loop suspected)`,
      );
    }
    throw err;
  }
}

/**
 * Извлечь весь текст из DjVu (text layer всех страниц, склеенных через \n\n).
 *
 * Iter 14.4 (2026-05-04): primary path — native pure-JS парсер; CLI остаётся
 * как graceful fallback. Native проверен на 289-page книге: 97% coverage,
 * 0 ошибок, 723ms (vs CLI 226ms но требует vendored .exe). См. комментарий
 * `shouldUseNative()` сверху файла.
 */
export async function runDjvutxt(filePath: string, signal?: AbortSignal): Promise<string> {
  if (shouldUseNative()) {
    try {
      return await runDjvutxtNative(filePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!shouldFallbackToCli()) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[djvu] native parser failed, falling back to CLI: ${msg.slice(0, 200)}`);
    }
  }
  const tool = await resolveBinary("djvutxt");
  const { stdout } = await runBinary(tool.binary, [filePath], {
    signal,
    timeoutMs: DJVU_TIMEOUT_DJVUTXT_FULL_MS,
    watchdogName: "djvutxt-full",
    filePath,
  });
  return stdout.toString("utf8").trim();
}

export async function getDjvuPageCount(filePath: string, signal?: AbortSignal): Promise<number> {
  if (shouldUseNative()) {
    try {
      return await getDjvuPageCountNative(filePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!shouldFallbackToCli()) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[djvu] native page count failed, falling back to CLI: ${msg.slice(0, 200)}`);
    }
  }
  const tool = await resolveBinary("djvused");
  const { stdout } = await runBinary(tool.binary, [filePath, "-e", "n"], {
    signal,
    timeoutMs: DJVU_TIMEOUT_DJVUSED_MS,
    watchdogName: "djvused-pages",
    filePath,
  });
  const value = Number.parseInt(stdout.toString("utf8").trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

/**
 * DjVu outline (bookmarks): дерево глав встроенное в файл если автор оцифровки
 * сделал TOC. `djvused -e "print-outline"` отдаёт S-expression формата:
 *
 *   (bookmarks
 *     ("Глава 1" "#1")
 *     ("Глава 2" "#15"
 *       ("§ 2.1" "#16")
 *       ("§ 2.2" "#22")))
 *
 * Где число после `#` — page index (1-based). Парсер flat-стайл —
 * возвращает плоский список (вложенные подразделы тоже попадают, но без
 * иерархии). Если outline отсутствует или пустой — возвращает [].
 *
 * Использование: ChapterDetection в parseDjvu может предпочесть эти
 * page-границы регексам по тексту.
 */
export interface DjvuBookmark {
  title: string;
  pageIndex: number; /* 0-based для unify с runDjvutxtPage */
}

export async function getDjvuBookmarks(filePath: string, signal?: AbortSignal): Promise<DjvuBookmark[]> {
  let stdout: Buffer;
  try {
    const tool = await resolveBinary("djvused");
    const result = await runBinary(tool.binary, [filePath, "-e", "print-outline"], {
      signal,
      timeoutMs: DJVU_TIMEOUT_DJVUSED_MS,
      watchdogName: "djvused-outline",
      filePath,
    });
    stdout = result.stdout;
  } catch {
    /* outline missing / djvused unavailable — пустой список, не ошибка */
    return [];
  }

  const text = stdout.toString("utf8").trim();
  if (text.length === 0 || text === "()") return [];

  /* Flat-extract pairs ("title" "#page") через regex. Подходит для большинства
   * outline'ов; глубоко вложенные section'ы тоже попадут как flat записи —
   * иерархия не важна для chapter-границ. */
  const result: DjvuBookmark[] = [];
  const re = /\("([^"]+)"\s+"#(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const title = match[1].trim();
    const oneBased = Number.parseInt(match[2], 10);
    if (!Number.isFinite(oneBased) || oneBased <= 0) continue;
    if (title.length === 0 || title.length > 200) continue;
    result.push({ title, pageIndex: oneBased - 1 });
  }
  /* Сортируем по pageIndex и удаляем дубликаты (one bookmark per page). */
  result.sort((a, b) => a.pageIndex - b.pageIndex);
  const dedup: DjvuBookmark[] = [];
  for (const b of result) {
    if (dedup.length === 0 || dedup[dedup.length - 1].pageIndex !== b.pageIndex) {
      dedup.push(b);
    }
  }
  return dedup;
}

export async function runDdjvu(filePath: string, pageIndex: number, dpi: number, signal?: AbortSignal): Promise<Buffer> {
  const tool = await resolveBinary("ddjvu");
  const out = path.join(tmpdir(), `bibliary-djvu-${randomUUID()}.tif`);
  const page = Math.max(1, pageIndex + 1);
  try {
    await runBinary(
      tool.binary,
      ["-format=tiff", `-page=${page}`, `-scale=${Math.max(72, dpi)}`, filePath, out],
      {
        signal,
        timeoutMs: DJVU_TIMEOUT_DDJVU_PAGE_MS,
        watchdogName: "ddjvu-page-tiff",
        filePath,
      },
    );
    return await fs.readFile(out);
  } finally {
    await fs.unlink(out).catch((err) => {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      console.error("[djvu-cli/renderPage] unlink Error:", err);
    });
  }
}

/**
 * Конвертирует весь DjVu в имиджевый PDF через `ddjvu -format=pdf`.
 *
 * Используется DjVu converter'ом (`converters/djvu.ts`) когда в DjVu нет
 * текстового слоя — конвертим в PDF и делегируем обычному pdfParser, у которого
 * уже отлажен путь rasterise → OS OCR / vision-LLM. Это сохраняет принцип
 * «формат = контейнер»: вместо собственного OCR-цикла внутри djvu.ts
 * используем существующий pipeline.
 *
 * Caller отвечает за `outPath` (обычно — `tmpdir/bibliary-djvu-<uuid>.pdf`).
 * Функция НЕ удаляет outPath — это обязанность caller'а через cleanup().
 */
export async function runDdjvuToPdf(srcPath: string, outPath: string, signal?: AbortSignal): Promise<void> {
  const tool = await resolveBinary("ddjvu");
  await runBinary(tool.binary, ["-format=pdf", srcPath, outPath], {
    signal,
    timeoutMs: DJVU_TIMEOUT_DDJVU_TO_PDF_MS,
    watchdogName: "ddjvu-to-pdf",
    filePath: srcPath,
  });
}

/**
 * Извлекает текстовый слой одной страницы DjVu через `djvutxt --page=N`.
 *
 * Используется per-page cascade в parseDjvu: для каждой страницы пробуем сначала
 * встроенный текст (бесплатно). Если на странице ≥ POROГ chars осмысленного
 * текста — пропускаем OCR. Это даёт 80%+ экономию heavy lane на смешанных DjVu,
 * где часть страниц имеет OCR-слой (например научные книги где formula-страницы
 * без слоя, а текстовые — с OCR от FineReader).
 *
 * Возвращает trimmed text. Пустую строку если djvutxt упал или страницы нет.
 * НЕ throw — graceful degradation, caller просто получит пусто и пойдёт в OCR.
 */
export async function runDjvutxtPage(srcPath: string, pageIndex: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return "";
  if (shouldUseNative()) {
    try {
      return await runDjvutxtPageNative(srcPath, pageIndex, signal);
    } catch (err) {
      if (!shouldFallbackToCli() && !signal?.aborted) throw err;
      if (!signal?.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[djvu] native page ${pageIndex + 1} failed, falling back to CLI: ${msg.slice(0, 200)}`);
      }
    }
  }
  const tool = await resolveBinary("djvutxt");
  const page = Math.max(1, pageIndex + 1);
  try {
    const { stdout } = await runBinary(tool.binary, [`--page=${page}`, srcPath], {
      signal,
      timeoutMs: DJVU_TIMEOUT_DJVUTXT_PAGE_MS,
      watchdogName: "djvutxt-page",
      filePath: srcPath,
    });
    return stdout.toString("utf8").trim();
  } catch {
    return "";
  }
}

export function getDjvuInstallHint(): string {
  return "Install DjVuLibre or keep bundled binaries (djvutxt.exe/ddjvu.exe/djvused.exe) in vendor/djvulibre/win32-x64";
}
