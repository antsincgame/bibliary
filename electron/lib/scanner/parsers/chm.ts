/**
 * CHM Parser — Microsoft Compiled HTML Help.
 *
 * Phase A+B Iter 9.5 (rev. 2 colibri-roadmap.md). Заменяет Calibre cascade для
 * .chm файлов. Стратегия: 7zip умеет распаковывать CHM (контейнер ITSF/LZX) в
 * HTML-файлы; дальше переиспользуем существующий composite-html-detector.
 *
 * АРХИТЕКТУРА:
 *
 *   1. 7zip CLI: `7z x file.chm -o<tmpdir>` распаковывает CHM в HTML+ассеты.
 *      Поддерживается из коробки 7z 16+ (vendored).
 *   2. composite-html-detector сканирует tmpdir на HTML-файлы (которых обычно
 *      десятки или сотни в CHM — туториалы, MSDN, books).
 *   3. assembleCompositeHtmlBook собирает все HTML в единый ParseResult с
 *      секциями (chapter-per-file) и параграфами.
 *   4. Cleanup tmpdir в finally.
 *
 * ЛИЦЕНЗИЯ: 7zip — LGPL CLI subprocess (изолировано). Никаких GPL-зависимостей
 * как у Calibre не привнесено.
 *
 * Замечания по форматам внутри CHM:
 *   - HTML pages — основной content (95% случаев)
 *   - .hhc / .hhk — Table of Contents и Index (XML-based, можно парсить для TOC)
 *     → пока не парсим, composite-html-detector использует alphabetical sort
 *   - Иногда внутри CHM лежат картинки → composite-html-detector их игнорирует
 */

import { promises as fs } from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { platformVendorDirsWithLegacy, platformExeName } from "../../platform.js";
import {
  detectCompositeHtmlDir,
  assembleCompositeHtmlBook,
} from "../../library/composite-html-detector.js";
import type { BookParser, ParseOptions, ParseResult } from "./types.js";

const CHM_EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Находит 7z бинарник в vendor/ (Win/Linux/macOS) или системный PATH.
 * Зеркалит resolve7zBinary из archive-extractor.ts, но без `7zip-bin` npm
 * fallback (тут достаточно vendor).
 */
async function resolve7zBinary(): Promise<string | null> {
  const env = process.env.BIBLIARY_7Z_PATH?.trim();
  if (env) {
    try {
      await fs.access(env);
      return env;
    } catch {
      /* env path invalid, продолжим */
    }
  }
  const exeName = platformExeName("7z");
  const cwd = process.cwd();
  const roots: string[] = [];
  for (const subdir of platformVendorDirsWithLegacy()) {
    roots.push(path.join(cwd, "vendor", "7zip", subdir));
    if (process.resourcesPath) {
      roots.push(path.join(process.resourcesPath, "vendor", "7zip", subdir));
    }
  }
  for (const root of roots) {
    const candidate = path.join(root, exeName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  /* Linux/macOS — обычно 7z в PATH через apt/brew. */
  if (process.platform !== "win32") return "7z";
  return null;
}

/**
 * Запускает `7z x <archive> -o<destDir> -y` с timeout watchdog.
 * Возвращает stderr на ошибке для warnings.
 */
function run7zExtract(
  binary: string,
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("7z extract aborted"));
      return;
    }
    const child = spawn(
      binary,
      ["x", archivePath, `-o${destDir}`, "-y", "-bso0", "-bsp0"],
      { windowsHide: true },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`7z extract timeout (${CHM_EXTRACT_TIMEOUT_MS}ms)`));
    }, CHM_EXTRACT_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill();
      clearTimeout(timer);
      reject(new Error("7z extract aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`7z exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * Парсит CHM файл: 7z extract → composite-html assembler → ParseResult.
 *
 * Graceful degradation:
 *   - 7z отсутствует → empty result + warning (как было при отсутствии Calibre)
 *   - 7z exited 1 (corrupt CHM) → empty result + warning
 *   - <10 HTML files после extract → composite detector вернёт null → warning
 */
async function parseChm(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const baseName = path.basename(filePath, path.extname(filePath));
  const warnings: string[] = [];

  const sevenZip = await resolve7zBinary();
  if (!sevenZip) {
    warnings.push(`chm: 7zip binary not found; install vendor/7zip or set BIBLIARY_7Z_PATH`);
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  const extractDir = path.join(tmpdir(), `bibliary-chm-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(extractDir, { recursive: true });

  try {
    try {
      await run7zExtract(sevenZip, filePath, extractDir, opts.signal);
    } catch (err) {
      warnings.push(
        `chm: 7z extract failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
    }

    /* composite-html-detector ищет в директории HTML-файлы (>= 10 шт) и собирает
       их в одну книгу. Если CHM содержит < 10 HTML — composite не сработает,
       но это редкий случай (минимальный CHM обычно содержит десятки страниц). */
    const composite = await detectCompositeHtmlDir(extractDir);
    if (!composite) {
      warnings.push(
        `chm: extracted ${extractDir} did not yield composite HTML book (<10 HTML files)`,
      );
      return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
    }

    const result = await assembleCompositeHtmlBook(composite);
    return {
      metadata: {
        ...result.metadata,
        title: result.metadata.title || baseName,
        warnings: [
          `chm: extracted via 7zip → ${composite.files.length} HTML pages assembled`,
          ...warnings,
          ...result.metadata.warnings,
        ],
      },
      sections: result.sections,
      rawCharCount: result.rawCharCount,
    };
  } finally {
    /* Cleanup tmpdir рекурсивно — best effort. */
    await fs.rm(extractDir, { recursive: true, force: true }).catch((rmErr) => {
      console.warn("[parsers/chm] tmpdir cleanup failed:", rmErr);
    });
  }
}

export const chmParser: BookParser = { ext: "chm", parse: parseChm };
