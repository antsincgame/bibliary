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

export interface WalkOptions {
  /** Если true, архивы (zip/cbz/...) тоже yields для последующей распаковки. */
  includeArchives?: boolean;
  /** Прерывание обхода. */
  signal?: AbortSignal;
  /** Максимальная глубина (anti-runaway, защита от циклов через симлинки). */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 16;

/**
 * Async generator: yield абсолютные пути к каждому подходящему файлу.
 * Прерывает обход (не throw) при `signal.aborted`.
 */
export async function* walkSupportedFiles(
  rootDir: string,
  supported: ReadonlySet<SupportedExt>,
  opts: WalkOptions = {},
): AsyncGenerator<string> {
  const includeArchives = opts.includeArchives === true;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  yield* walkDir(rootDir, supported, includeArchives, opts.signal, 0, maxDepth);
}

async function* walkDir(
  dir: string,
  supported: ReadonlySet<SupportedExt>,
  includeArchives: boolean,
  signal: AbortSignal | undefined,
  depth: number,
  maxDepth: number,
): AsyncGenerator<string> {
  if (signal?.aborted) return;
  if (depth > maxDepth) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (signal?.aborted) return;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* walkDir(full, supported, includeArchives, signal, depth + 1, maxDepth);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = detectExt(entry.name);
    if (ext && supported.has(ext)) {
      yield full;
      continue;
    }
    if (includeArchives && isArchive(full)) yield full;
  }
}
