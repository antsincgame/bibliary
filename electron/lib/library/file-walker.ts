/**
 * Streaming file walker — async generator вместо buffer-all обхода каталога.
 *
 * До: `collectFiles` рекурсивно копил полный список в массив до старта
 * импорта. На папке с 50k файлов прогресс начинал течь только после полного
 * scan'а (десятки секунд), и memory держала весь array путей.
 *
 * После: walker yields каждый поддерживаемый файл по мере обхода. Импорт
 * стартует на первом же файле, scanner работает параллельно с парсером.
 *
 * Контракт:
 *   - Обход в порядке `readdir` (file-system order). Не сортируется.
 *   - Поддерживаемые форматы и опциональные архивы фильтруются здесь же.
 *   - Тихо пропускаются нечитаемые директории (нет прав, симлинк-битый и т.д.).
 *   - AbortSignal проверяется на каждой директории.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { detectExt, type SupportedExt } from "../scanner/parsers/index.js";
import { isArchive } from "./archive-extractor.js";
import { shouldIncludeImportCandidate } from "./import-candidate-filter.js";

export interface WalkOptions {
  /** Если true, архивы (zip/cbz/...) тоже yields для последующей распаковки. */
  includeArchives?: boolean;
  /** Прерывание обхода. */
  signal?: AbortSignal;
  /** Максимальная глубина (anti-runaway, защита от циклов через симлинки). */
  maxDepth?: number;
  /** Minimum file size in bytes. Files smaller are skipped (not real books). Default 10240 (10 KB). */
  minFileBytes?: number;
  /** If true, directories containing ≥ MIN_HTML_CLUSTER_SIZE HTML files are yielded
   *  as special sentinel paths so the caller can create CompositeHtmlBook tasks. */
  detectCompositeHtml?: boolean;
}

/**
 * Minimum number of HTML files in a directory to be treated as a Composite HTML Book.
 * Must match composite-html-detector.ts MIN_HTML_FILES_FOR_COMPOSITE.
 */
const MIN_HTML_CLUSTER_SIZE = 10;

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MIN_FILE_BYTES = 10_240; // 10 KB — no real book is smaller

const DIR_BLACKLIST: ReadonlySet<string> = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "__pycache__", ".tox", ".mypy_cache",
  ".idea", ".vscode", ".vs",
  "build", "dist", "target", "out", "bin", "obj",
  "vendor",
  "BlackBox.AD",
  // companion code & supplementary material — NOT book content
  // IMPORTANT: "html", "htm", "docu" are intentionally excluded —
  // they may contain Composite HTML Books (Perl nutshell, MSDN dumps, etc.)
  "cd", "extras", "listings", "exercises",
  "solutions", "tasks", "sym", "mod", "rsrc",
  "supplement", "bonus",
  // code / example / sample directories — always companion code, never a book
  "code", "codes",
  "examples", "example",
  "samples", "sample",
  "resources", "resource",
]);

const BASENAME_BLACKLIST: ReadonlySet<string> = new Set([
  "readme", "readme.md", "readme.txt", "readme.rst",
  "license", "license.txt", "license.md",
  "changelog", "changelog.md", "changes.md",
  "makefile", "cmakelists.txt",
  "dockerfile", ".gitignore", ".editorconfig", ".eslintrc",
  "package.json", "tsconfig.json", "cargo.toml",
]);

/**
 * Sentinel prefix prepended to directory paths yielded as Composite HTML Book candidates.
 * Caller strips this prefix and calls detectCompositeHtmlDir() on the remaining path.
 */
export const COMPOSITE_HTML_SENTINEL = "composite-html:";

/**
 * Async generator: yield абсолютные пути к каждому подходящему файлу.
 * If detectCompositeHtml=true, also yields directories containing ≥ MIN_HTML_CLUSTER_SIZE
 * HTML files as "composite-html:<absDir>" sentinel strings.
 * Прерывает обход (не throw) при `signal.aborted`.
 */
export async function* walkSupportedFiles(
  rootDir: string,
  supported: ReadonlySet<SupportedExt>,
  opts: WalkOptions = {},
): AsyncGenerator<string> {
  const includeArchives = opts.includeArchives === true;
  const detectComposite = opts.detectCompositeHtml === true;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const minBytes = opts.minFileBytes ?? DEFAULT_MIN_FILE_BYTES;
  const signal = opts.signal;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  /** Directories already yielded as composite candidates — don't recurse into them. */
  const compositeDirs = new Set<string>();

  while (stack.length > 0) {
    if (signal?.aborted) return;
    const next = stack.pop();
    if (!next) break;
    if (next.depth > maxDepth) continue;

    let entries;
    try {
      entries = await fs.readdir(next.dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    // Count HTML files in this directory for composite detection
    let htmlCount = 0;
    if (detectComposite) {
      for (const e of entries) {
        if (e.isFile()) {
          const l = e.name.toLowerCase();
          if (l.endsWith(".html") || l.endsWith(".htm")) htmlCount++;
        }
      }
    }

    if (detectComposite && htmlCount >= MIN_HTML_CLUSTER_SIZE) {
      // Yield this dir as a composite HTML book candidate and don't recurse into it
      compositeDirs.add(next.dir);
      yield `${COMPOSITE_HTML_SENTINEL}${next.dir}`;
      continue;
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      if (signal?.aborted) return;
      const entry = entries[i]!;
      const full = path.join(next.dir, entry.name);

      if (entry.isDirectory()) {
        if (DIR_BLACKLIST.has(entry.name.toLowerCase())) continue;
        if (compositeDirs.has(full)) continue;
        stack.push({ dir: full, depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      const lower = entry.name.toLowerCase();
      if (BASENAME_BLACKLIST.has(lower)) continue;

      const ext = detectExt(entry.name);
      const isBook = Boolean(ext && supported.has(ext));
      const isArch = !isBook && includeArchives && isArchive(full);
      if (!isBook && !isArch) continue;

      try {
        const st = await fs.stat(full);
        if (minBytes > 0 && st.size < minBytes) continue;
        if (
          ext &&
          isBook &&
          !shouldIncludeImportCandidate({
            rootDir,
            candidatePath: full,
            ext,
            sizeBytes: st.size,
          })
        ) {
          continue;
        }
      } catch {
        continue;
      }

      yield full;
    }
  }
}
