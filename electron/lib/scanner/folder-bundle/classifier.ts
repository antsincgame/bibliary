/**
 * Folder-Bundle Classifier — обходит папку с книгой и классифицирует
 * каждый файл-сосед: основная книга / иллюстрация / пример кода / скачанный
 * сайт / архив / неизвестное.
 *
 * Дизайн-цели:
 *  - Pure-Node, без LLM на этом слое (LLM-описание идёт отдельной стадией).
 *  - Никаких сетевых обращений.
 *  - Предсказуемый порядок (по lowercase-пути) — облегчает диффы и тесты.
 *
 * Контракт:
 *  - На вход принимает абсолютный путь к папке.
 *  - На выход — `BookBundle` с найденной «основной книгой» (если есть) и
 *    списком sidecars.
 *  - Если основной книги нет (только примеры/изображения) — возвращает
 *    `bundle.book = null`. Решение, что с этим делать, принимает caller.
 */

import { promises as fs } from "fs";
import * as path from "path";

/** Категории файлов внутри папки. */
export type FileKind =
  | "book"        // PDF/EPUB/FB2/DOCX и пр. — кандидат на «основную книгу»
  | "image"       // png/jpg/webp/...
  | "code"        // исходники программ (по расширению)
  | "html-site"   // папка `*_files` или index.html — скачанный сайт
  | "archive"     // zip/rar/7z/tar — пропускаем (архивы не разбираем)
  | "metadata"    // README, TOC, opf, ncx — служебные
  | "unknown";

export interface ClassifiedFile {
  /** Абсолютный путь. */
  absPath: string;
  /** Относительный путь от корня bundle (для md-ссылок). */
  relPath: string;
  /** Имя без расширения. */
  baseName: string;
  /** Lowercased extension без точки (`pdf`, `png`). */
  ext: string;
  /** Размер в байтах. */
  size: number;
  kind: FileKind;
}

export interface BookBundle {
  rootDir: string;
  /** Основная книга: первый PDF/EPUB/... приоритетно по размеру. null если нет. */
  book: ClassifiedFile | null;
  /** Все остальные файлы (включая «вторые» книги — как sidecars). */
  sidecars: ClassifiedFile[];
  /** Файлы, которые мы скипаем (архивы, скрытые). Учитываются для статистики. */
  skipped: ClassifiedFile[];
  /** Тёплые предупреждения для UI: что заметили, но не упали. */
  warnings: string[];
}

const BOOK_EXTS = new Set(["pdf", "epub", "fb2", "djvu", "mobi", "azw", "azw3"]);
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg",
]);
const CODE_EXTS = new Set([
  "py", "ts", "tsx", "js", "jsx", "java", "kt", "kts", "swift", "go",
  "rs", "c", "h", "cpp", "hpp", "cs", "rb", "php", "sh", "bash",
  "ipynb", "lua", "scala", "ex", "exs", "ml", "fs", "sql", "r", "jl",
]);
const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
const METADATA_NAMES = new Set([
  "readme", "readme.md", "readme.txt", "license", "license.txt",
  "toc", "toc.ncx", "container.xml",
]);
const METADATA_EXTS = new Set(["opf", "ncx"]);

const HIDDEN_PREFIX = ".";
const SKIP_DIRNAMES = new Set([".git", "node_modules", "__macosx", ".ds_store", "thumbs.db"]);

function ext(p: string): string {
  const e = path.extname(p);
  return e ? e.slice(1).toLowerCase() : "";
}

function classify(file: { absPath: string; relPath: string; baseName: string; ext: string; size: number }): FileKind {
  const lowerName = (file.baseName + (file.ext ? "." + file.ext : "")).toLowerCase();
  if (METADATA_NAMES.has(lowerName) || METADATA_EXTS.has(file.ext)) return "metadata";
  if (BOOK_EXTS.has(file.ext)) return "book";
  if (IMAGE_EXTS.has(file.ext)) return "image";
  if (CODE_EXTS.has(file.ext)) return "code";
  if (ARCHIVE_EXTS.has(file.ext)) return "archive";

  /* HTML-site: index.html в любой папке, или путь содержит сегмент `_files`. */
  const lowerRel = file.relPath.replace(/\\/g, "/").toLowerCase();
  if (file.ext === "html" || file.ext === "htm") {
    if (lowerName === "index.html" || /\/_?files\//.test(lowerRel) || lowerRel.includes("_files/")) {
      return "html-site";
    }
    /* единичный html — может быть как книгой, так и страницей; считаем кодом-сайтом. */
    return "html-site";
  }
  return "unknown";
}

/**
 * Рекурсивно обходит папку и классифицирует файлы.
 * Скрытые файлы и папки из `SKIP_DIRNAMES` пропускаются молча.
 *
 * @param maxFiles — защитный кэп; default 5000 (достаточно для скачанного сайта).
 */
export async function discoverBundle(rootDir: string, maxFiles = 5000): Promise<BookBundle> {
  const warnings: string[] = [];
  const all: ClassifiedFile[] = [];

  const stat = await fs.stat(rootDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`folder-bundle: rootDir is not a directory: ${rootDir}`);
  }

  async function walk(dir: string): Promise<void> {
    if (all.length >= maxFiles) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`readdir failed at ${dir}: ${e instanceof Error ? e.message : e}`);
      return;
    }
    /* стабильный порядок — облегчает воспроизводимость. */
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith(HIDDEN_PREFIX)) continue;
      if (SKIP_DIRNAMES.has(name.toLowerCase())) continue;
      const abs = path.join(dir, name);
      if (ent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      let size = 0;
      try { size = (await fs.stat(abs)).size; } catch { /* skip */ }
      const rel = path.relative(rootDir, abs);
      const baseName = path.basename(name, path.extname(name));
      const e = ext(name);
      const meta = { absPath: abs, relPath: rel, baseName, ext: e, size };
      all.push({ ...meta, kind: classify(meta) });
      if (all.length >= maxFiles) {
        warnings.push(`folder-bundle: max files cap reached (${maxFiles}); rest skipped`);
        return;
      }
    }
  }

  await walk(rootDir);

  /* Выбираем «основную книгу»: самый большой файл с book-ext. Heuristic
     достаточно работает: в сборках чаще всего основной — крупнейший .pdf/.epub. */
  const books = all.filter((f) => f.kind === "book");
  const mainBook = books.length > 0
    ? books.reduce((acc, x) => (x.size > acc.size ? x : acc), books[0]!)
    : null;

  const sidecars: ClassifiedFile[] = [];
  const skipped: ClassifiedFile[] = [];
  for (const f of all) {
    if (mainBook && f.absPath === mainBook.absPath) continue;
    if (f.kind === "archive") { skipped.push(f); continue; }
    sidecars.push(f);
  }

  if (books.length > 1) {
    warnings.push(
      `folder-bundle: multiple books found (${books.length}). Picked "${mainBook!.relPath}" by size; ` +
      `others kept as sidecars. Curator step (later) will resolve duplicate editions.`,
    );
  }
  if (mainBook === null && sidecars.length > 0) {
    warnings.push(
      `folder-bundle: no main book file found; only sidecars (${sidecars.length}). ` +
      `Bundle will be an "examples-only" package.`,
    );
  }

  return { rootDir, book: mainBook, sidecars, skipped, warnings };
}
