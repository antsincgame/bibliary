/**
 * Library Import Service — единственный способ положить книгу в каталог.
 *
 * Контракт:
 *   1. SHA-256 дедупликация (две одинаковые книги -> одна запись, status сохраняется).
 *   2. Парсинг + Markdown через `convertBookToMarkdown` (CPU-задача, безопасна
 *      рядом с GPU-кристаллизацией).
 *   3. Копирование оригинала в `library/{slug}/original.{ext}` для портативности.
 *   4. Запись `book.md` рядом.
 *   5. Upsert в SQLite-кэш (status='imported').
 *   6. Опциональный push в evaluator-queue (передаётся как callback,
 *      чтобы избежать circular import между import.ts и evaluator-queue.ts).
 *
 * НЕ вызывает LLM. Эвалюация полностью отделена -- queue заберёт книгу позже.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { detectExt, type SupportedExt } from "../scanner/parsers/index.js";
import { convertBookToMarkdown } from "./md-converter.js";
import { getLibraryRoot, getBookDir } from "./paths.js";
import { upsertBook, getBookById, getKnownSha256s } from "./cache-db.js";
import { extractArchive, isArchive, cleanupExtractedDir } from "./archive-extractor.js";
import type { BookCatalogMeta } from "./types.js";

const SUPPORTED_BOOK_EXTS: ReadonlySet<SupportedExt> = new Set(["pdf", "epub", "fb2", "txt", "docx"]);

export interface ImportResult {
  /** "added" -- новая книга. "duplicate" -- уже была (SHA совпал). "skipped" -- неподдерживаемый формат. "failed" -- ошибка парсинга. */
  outcome: "added" | "duplicate" | "skipped" | "failed";
  bookId?: string;
  meta?: BookCatalogMeta;
  warnings: string[];
  /** Текст ошибки если outcome='failed'. */
  error?: string;
  /** Имя архива-источника, если книга пришла из распаковки. */
  sourceArchive?: string;
}

export interface ImportFolderOptions {
  /** Если true -- сканировать архивы (zip/cbz/rar/7z/cbr) и распаковывать. */
  scanArchives?: boolean;
  /** OCR-флаг для PDF (медленно). По умолчанию false. */
  ocrEnabled?: boolean;
  /** Прерывание (например, юзер нажал Stop). */
  signal?: AbortSignal;
  /** Колбэк прогресса: вызывается после каждого файла. */
  onProgress?: (event: ProgressEvent) => void;
  /** Колбэк после успешного импорта -- evaluator-queue его подхватывает. */
  onBookImported?: (meta: BookCatalogMeta) => void;
}

export interface ProgressEvent {
  index: number;
  total: number;
  currentFile: string;
  outcome: ImportResult["outcome"];
}

export interface ImportFolderResult {
  total: number;
  added: number;
  duplicate: number;
  skipped: number;
  failed: number;
  warnings: string[];
}

/** Импортирует один файл (книгу или архив). Возвращает массив результатов (архив = много). */
export async function importFile(absPath: string, opts: Omit<ImportFolderOptions, "onProgress"> = {}): Promise<ImportResult[]> {
  if (isArchive(absPath)) {
    if (opts.scanArchives === false) {
      return [{ outcome: "skipped", warnings: [`import: archive scanning disabled, skipped ${path.basename(absPath)}`] }];
    }
    return importArchive(absPath, opts);
  }
  return [await importBookFromFile(absPath, opts)];
}

/** Извлекает архив, импортирует все поддерживаемые книги, чистит temp. */
async function importArchive(absPath: string, opts: Omit<ImportFolderOptions, "onProgress">): Promise<ImportResult[]> {
  const sourceArchive = path.basename(absPath);
  const extractRes = await extractArchive(absPath);
  const results: ImportResult[] = [];

  if (extractRes.books.length === 0) {
    results.push({ outcome: "skipped", warnings: extractRes.warnings, sourceArchive });
    await cleanupExtractedDir(extractRes.tempDir);
    return results;
  }

  for (const book of extractRes.books) {
    if (opts.signal?.aborted) break;
    const r = await importBookFromFile(book.absPath, { ...opts, sourceArchive });
    /* Подмешиваем archive warnings к первому результату для трассировки. */
    if (results.length === 0) r.warnings = [...extractRes.warnings, ...r.warnings];
    results.push(r);
  }

  await cleanupExtractedDir(extractRes.tempDir);
  return results;
}

/** Импорт одной книги. Внутренний инвариант: caller гарантирует supported format. */
export async function importBookFromFile(
  absPath: string,
  opts: Omit<ImportFolderOptions, "onProgress" | "scanArchives"> & { sourceArchive?: string } = {},
): Promise<ImportResult> {
  const warnings: string[] = [];
  const ext = detectExt(absPath);
  if (!ext || !SUPPORTED_BOOK_EXTS.has(ext)) {
    return { outcome: "skipped", warnings: [`import: unsupported format ${path.extname(absPath)}`], sourceArchive: opts.sourceArchive };
  }

  /* SHA-256 -- дёшево, делаем сразу, до парсинга, для дедупа. */
  let convResult;
  try {
    convResult = await convertBookToMarkdown(absPath, { ocrEnabled: opts.ocrEnabled === true, signal: opts.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: msg, sourceArchive: opts.sourceArchive };
  }
  warnings.push(...(convResult.meta.warnings ?? []));

  /* Дедуп по SHA-256 содержимого. Если уже есть -- ничего не пишем. */
  const known = getKnownSha256s();
  const dupId = known.get(convResult.meta.sha256);
  if (dupId) {
    const existing = getBookById(dupId);
    return {
      outcome: "duplicate",
      bookId: dupId,
      meta: existing ?? undefined,
      warnings: [...warnings, `import: duplicate of ${dupId} (SHA-256 match)`],
      sourceArchive: opts.sourceArchive,
    };
  }

  /* Подготавливаем папку library/{slug}/. Slug = meta.id (16 hex). */
  const root = await getLibraryRoot();
  const bookDir = getBookDir(root, convResult.meta.id);
  await fs.mkdir(bookDir, { recursive: true });

  /* Копируем оригинал. Имя файла нормализуем как `original.{ext}`. */
  const originalDest = path.join(bookDir, `original.${ext}`);
  try {
    await fs.copyFile(absPath, originalDest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `copy-original failed: ${msg}`, sourceArchive: opts.sourceArchive };
  }

  /* Обновляем meta: originalFile = "original.{ext}", добавляем sourceArchive. */
  const finalMeta: BookCatalogMeta = {
    ...convResult.meta,
    originalFile: path.basename(originalDest),
    sourceArchive: opts.sourceArchive,
  };

  /* Перестраиваем markdown с финальной meta (новый frontmatter). */
  const mdPath = path.join(bookDir, "book.md");
  const finalMd = rebuildMarkdownWithFinalMeta(convResult.markdown, finalMeta);
  try {
    await fs.writeFile(mdPath, finalMd, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `write book.md failed: ${msg}`, sourceArchive: opts.sourceArchive };
  }

  upsertBook(finalMeta, mdPath);

  return { outcome: "added", bookId: finalMeta.id, meta: finalMeta, warnings, sourceArchive: opts.sourceArchive };
}

/** Заменяет frontmatter в готовом markdown на финальный (после копирования оригинала). */
function rebuildMarkdownWithFinalMeta(markdown: string, finalMeta: BookCatalogMeta): string {
  /* Используем replaceFrontmatter из md-converter -- именно для этого она там. */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { replaceFrontmatter } = require("./md-converter.js") as typeof import("./md-converter.js");
  return replaceFrontmatter(markdown, finalMeta);
}

/**
 * Импорт всей папки рекурсивно. Один вызов = одна транзакция от UI.
 *
 * НЕ запускает эвалюацию -- caller (IPC handler) пушит каждую новую книгу
 * в evaluator-queue через `onBookImported` callback.
 */
export async function importFolderToLibrary(folderPath: string, opts: ImportFolderOptions = {}): Promise<ImportFolderResult> {
  const stat = await fs.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`importFolderToLibrary: not a directory: ${folderPath}`);
  }

  /* Рекурсивный обход. Берём только supported форматы и (опционально) архивы. */
  const files: string[] = [];
  await collectFiles(folderPath, files, opts.scanArchives === true);

  const result: ImportFolderResult = { total: files.length, added: 0, duplicate: 0, skipped: 0, failed: 0, warnings: [] };

  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) break;
    const file = files[i];
    const itemResults = await importFile(file, opts);
    for (const r of itemResults) {
      result[r.outcome] += 1;
      if (r.warnings.length > 0) result.warnings.push(...r.warnings);
      if (r.outcome === "added" && r.meta && opts.onBookImported) opts.onBookImported(r.meta);
    }
    opts.onProgress?.({
      index: i + 1,
      total: files.length,
      currentFile: file,
      outcome: itemResults[0]?.outcome ?? "failed",
    });
  }

  return result;
}

async function collectFiles(dir: string, acc: string[], includeArchives: boolean): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, acc, includeArchives);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = detectExt(entry.name);
    if (ext && SUPPORTED_BOOK_EXTS.has(ext)) {
      acc.push(full);
      continue;
    }
    if (includeArchives && isArchive(full)) acc.push(full);
  }
}
