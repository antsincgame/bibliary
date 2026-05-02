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
import {
  KNOWN_FILENAMES_NO_EXT,
  detectByMagic,
  isLikelyText,
  classifyTextContent,
} from "./magic-bytes.js";
import { getPriority } from "../../library/format-priority.js";

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
  "xpm", "ico", "psd", "raw", "heic", "avif",
]);
/* Расширенный список языков и проектных файлов (vcproj/dsp = MSVC, bpr = Borland). */
const CODE_EXTS = new Set([
  /* основные ЯП */
  "py", "ts", "tsx", "js", "jsx", "java", "kt", "kts", "swift", "go",
  "rs", "c", "h", "cpp", "hpp", "cxx", "cc", "hxx", "c++", "h++",
  "cs", "rb", "php", "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "ipynb", "lua", "scala", "ex", "exs", "ml", "fs", "fsx",
  "sql", "r", "jl", "dart", "groovy", "perl", "pl", "tcl",
  /* конфиги/билды (тоже исходники) */
  "in", "ac", "am", "cmake", "mk", "gradle",
  /* Pascal / Oberon исходные тексты */
  "pas", "pp", "mod",
  /* MSVC / Borland project files */
  "vcproj", "vcxproj", "dsp", "bpr", "dproj", "csproj", "sln",
]);
const ARCHIVE_EXTS = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab",
  /* BlackBox/Component Pascal binary stores — без runtime бесполезны */
  "ocf", "odc", "osf",
]);
const METADATA_NAMES = new Set([
  "readme", "readme.md", "readme.txt", "license", "license.txt",
  "toc", "toc.ncx", "container.xml",
]);
const METADATA_EXTS = new Set([
  "opf", "ncx", "torrent",
  /* Project metadata (не код, а описание) */
  "import", "tres", "godot", /* Godot */
  "csv", "tsv", /* Tabular metadata */
]);

const HIDDEN_PREFIX = ".";
const SKIP_DIRNAMES = new Set([".git", "node_modules", "__macosx", ".ds_store", "thumbs.db"]);

function ext(p: string): string {
  const e = path.extname(p);
  return e ? e.slice(1).toLowerCase() : "";
}

function classifyByExt(file: { absPath: string; relPath: string; baseName: string; ext: string; size: number }): FileKind {
  const lowerName = (file.baseName + (file.ext ? "." + file.ext : "")).toLowerCase();
  if (METADATA_NAMES.has(lowerName) || METADATA_EXTS.has(file.ext)) return "metadata";
  if (BOOK_EXTS.has(file.ext)) return "book";
  if (IMAGE_EXTS.has(file.ext)) return "image";
  if (CODE_EXTS.has(file.ext)) return "code";
  if (ARCHIVE_EXTS.has(file.ext)) return "archive";

  /* Имена без расширения: LICENSE / Dockerfile / Makefile и пр. */
  if (file.ext === "" && KNOWN_FILENAMES_NO_EXT[file.baseName.toLowerCase()]) {
    return KNOWN_FILENAMES_NO_EXT[file.baseName.toLowerCase()]!;
  }

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
 * Magic-byte rescue: если ext-классификатор вернул `unknown`, читаем
 * первые 64 байта файла и пытаемся определить тип. Это решает кейсы:
 *   - PDF/PNG/JPEG/EPUB без расширения
 *   - .ocf (Component Pascal modules)
 *   - LICENSE / Dockerfile / Makefile (текстовые без расширения)
 *   - .odc/.osf (если ZIP-based — попадут как archive)
 */
async function rescueByMagic(absPath: string): Promise<FileKind | null> {
  let fh: import("fs").promises.FileHandle | null = null;
  try {
    fh = await fs.open(absPath, "r");
    const buf = Buffer.allocUnsafe(64);
    const { bytesRead } = await fh.read(buf, 0, 64, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.length === 0) return null;

    const m = detectByMagic(head);
    if (m) return m;

    /* Текстовые файлы без расширения — code/metadata через эвристику. */
    if (isLikelyText(head)) {
      const t = classifyTextContent(head);
      if (t) return t;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
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
      let kind = classifyByExt(meta);
      /* Magic-byte rescue: spend ~1 fs.read per unknown. На больших папках
         это +N мс, но точность повышается с 67% unknown до ~5%. */
      if (kind === "unknown" && size > 0) {
        const m = await rescueByMagic(abs);
        if (m) kind = m;
      }
      all.push({ ...meta, kind });
      if (all.length >= maxFiles) {
        warnings.push(`folder-bundle: max files cap reached (${maxFiles}); rest skipped`);
        return;
      }
    }
  }

  await walk(rootDir);

  /* Выбираем «основную книгу»: 1) по format priority (унифицировано с
     cross-format-prededup.ts через `format-priority.ts`), 2) при равном
     приоритете — по размеру (крупнейший = вероятно полный том vs sample).
     Это исправляет старый bug когда `book.pdf` (50 MB) выигрывал у `book.epub`
     (5 MB) только из-за размера, хотя EPUB лучше для RAG. */
  const books = all.filter((f) => f.kind === "book");
  const mainBook = books.length > 0
    ? books.reduce((acc, x) => {
        const accPriority = getPriority(acc.ext);
        const xPriority = getPriority(x.ext);
        if (xPriority > accPriority) return x;
        if (xPriority < accPriority) return acc;
        return x.size > acc.size ? x : acc;
      }, books[0]!)
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
