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
import { killChildTree } from "../_vendor/resilience/kill-tree.js";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { platformVendorDirsWithLegacy, platformExeName } from "../_vendor/platform.js";
import {
  detectCompositeHtmlDir,
  assembleCompositeHtmlBook,
} from "../_vendor/library/composite-html-detector.js";
import type { BookParser, ParseOptions, ParseResult } from "./types.js";

const req = createRequire(path.join(process.cwd(), "package.json"));

const CHM_EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Resolves a 7-Zip binary: `BIBLIARY_7Z_PATH` env → vendored `vendor/7zip`
 * → the bundled `7z-bin` / `7zip-bin` npm package → bare `7z` on PATH.
 *
 * The npm fallback matters outside Electron (web service, CI, containers):
 * there is no `process.resourcesPath` bundle and `7z` is often absent from
 * PATH, so without it every CHM parse fails with `spawn 7z ENOENT`. Mirrors
 * `library/archive-extractor.ts` and `scanner/converters/cbz.ts`.
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
  /* Bundled npm binary — covers Linux/macOS/Windows where vendor/ is absent
     (web service, CI, Docker). `7z-bin` exposes `path7z`, `7zip-bin` `path7za`. */
  for (const pkg of ["7z-bin", "7zip-bin"]) {
    try {
      const mod = req(pkg) as { path7z?: string; path7za?: string };
      const resolved = mod.path7z ?? mod.path7za;
      if (typeof resolved === "string" && resolved.length > 0) {
        await fs.access(resolved);
        /* npm tarballs sometimes drop the execute bit — restore it so the
           spawn below doesn't fail with EACCES. Absolute paths only (a bare
           "7z" from USE_SYSTEM_7Z is left for PATH lookup). */
        if (path.isAbsolute(resolved)) {
          await fs.chmod(resolved, 0o755).catch(() => {});
        }
        return resolved;
      }
    } catch {
      /* optional helper package not present / path missing */
    }
  }
  /* Last resort — bare `7z` on PATH (apt/brew installs). */
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
      /* Iter 14.3: tree-kill вместо child.kill() — на Windows 7z может
         запускать поддочерние процессы которые переживут SIGTERM.
         См. `electron/lib/resilience/kill-tree.ts`. */
      killChildTree(child, { gracefulMs: 500 });
      reject(new Error(`7z extract timeout (${CHM_EXTRACT_TIMEOUT_MS}ms)`));
    }, CHM_EXTRACT_TIMEOUT_MS);

    const onAbort = (): void => {
      killChildTree(child, { gracefulMs: 500 });
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
 * 7z extracts a CHM into whatever internal folder layout it used — O'Reilly
 * titles nest every HTML page under an ISBN directory while the extraction
 * root holds only CHM metadata (#SYSTEM, #TOPICS, *.hhc). Walk the tree and
 * return the directory holding the largest HTML cluster, so the composite
 * detector is pointed at the content rather than the metadata root.
 */
async function findHtmlClusterDir(root: string): Promise<string> {
  let bestDir = root;
  let bestCount = -1;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let htmlCount = 0;
    for (const e of entries) {
      if (e.isDirectory()) {
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) htmlCount++;
      }
    }
    if (htmlCount > bestCount) {
      bestCount = htmlCount;
      bestDir = dir;
    }
  }
  return bestDir;
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

    /* 7z extracts CHM internals verbatim — the HTML cluster is usually nested
       in a subdirectory (e.g. an ISBN folder), not at the extraction root.
       Point the detector at the directory holding the actual pages. */
    const htmlDir = await findHtmlClusterDir(extractDir);
    const composite = await detectCompositeHtmlDir(htmlDir);
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
