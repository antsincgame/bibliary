/**
 * Archive Extractor — распаковка архивов с книгами в temp-директорию.
 *
 * Текущая реализация (lean): полноценная поддержка ZIP / CBZ через JSZip
 * (уже в зависимостях). Для RAR / 7z / CBR возвращает понятный warning,
 * не пытаясь подтянуть тяжёлые нативные бинарники в portable-сборку.
 *
 * Контракт: на выходе массив абсолютных путей к временно распакованным
 * книгам поддерживаемых форматов. Caller (import.ts) скармливает их
 * в обычный pipeline. Чистка temp-папки -- ответственность caller'а
 * через `cleanupExtractedDir(tempDir)`.
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { detectExt, type SupportedExt } from "../scanner/parsers/index.js";

const SUPPORTED_BOOK_EXTS: ReadonlySet<SupportedExt> = new Set(["pdf", "epub", "fb2", "txt", "docx"]);
const ARCHIVE_EXTS = new Set([".zip", ".cbz", ".rar", ".cbr", ".7z"]);

export interface ExtractedBook {
  /** Абсолютный путь к временно извлечённой книге. */
  absPath: string;
  /** Оригинальное имя записи внутри архива. */
  entryName: string;
  /** Имя архива (basename), для трассировки источника. */
  sourceArchive: string;
}

export interface ExtractResult {
  books: ExtractedBook[];
  tempDir: string;
  /** Warnings (например, "RAR not supported", "encrypted entry skipped"). */
  warnings: string[];
}

/** Возвращает true если расширение файла -- архив, который мы (в принципе) умеем читать. */
export function isArchive(filePath: string): boolean {
  return ARCHIVE_EXTS.has(path.extname(filePath).toLowerCase());
}

/** Создаёт уникальную temp-директорию под распаковку. */
async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "bibliary-archive-" + randomUUID().slice(0, 8));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Удаляет temp-директорию рекурсивно. Безопасно для повторного вызова. */
export async function cleanupExtractedDir(tempDir: string): Promise<void> {
  if (!tempDir.includes("bibliary-archive-")) return; /* защита от случайного rm -rf */
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

/** Безопасное имя файла для temp -- никаких path traversal из архива. */
function sanitizeEntryName(entryName: string): string {
  const base = path.basename(entryName);
  return base.replace(/[<>:"|?*\x00-\x1F]/g, "_");
}

async function extractZipLike(absPath: string, tempDir: string, warnings: string[]): Promise<ExtractedBook[]> {
  const buf = await fs.readFile(absPath);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`archive-extractor: cannot open ${path.basename(absPath)} as ZIP: ${msg}`);
    return [];
  }

  const out: ExtractedBook[] = [];
  const sourceArchive = path.basename(absPath);
  const seen = new Set<string>();

  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    const ext = detectExt(entry.name);
    if (!ext || !SUPPORTED_BOOK_EXTS.has(ext)) continue;
    let safeName = sanitizeEntryName(entry.name);
    /* Гарантируем уникальность имени в temp-директории. */
    let suffix = 0;
    while (seen.has(safeName)) {
      const ext2 = path.extname(safeName);
      safeName = `${path.basename(safeName, ext2)}__${++suffix}${ext2}`;
    }
    seen.add(safeName);

    try {
      const data = await entry.async("nodebuffer");
      const out_path = path.join(tempDir, safeName);
      await fs.writeFile(out_path, data);
      out.push({ absPath: out_path, entryName: entry.name, sourceArchive });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`archive-extractor: skipped ${entry.name} in ${sourceArchive}: ${msg}`);
    }
  }
  return out;
}

/**
 * Главный entry-point: распаковывает архив, возвращает поддерживаемые книги.
 *
 * Не поддерживаемые форматы возвращают пустой результат + warning.
 * Caller сам решает что делать (показать в UI, залогировать).
 */
export async function extractArchive(absPath: string): Promise<ExtractResult> {
  const ext = path.extname(absPath).toLowerCase();
  const warnings: string[] = [];
  const tempDir = await makeTempDir();

  if (ext === ".zip" || ext === ".cbz") {
    const books = await extractZipLike(absPath, tempDir, warnings);
    return { books, tempDir, warnings };
  }

  if (ext === ".rar" || ext === ".cbr") {
    warnings.push(
      `archive-extractor: RAR/CBR is not supported in portable mode (${path.basename(absPath)}). Please extract manually with WinRAR/7-Zip and re-import the resulting folder.`,
    );
    return { books: [], tempDir, warnings };
  }

  if (ext === ".7z") {
    warnings.push(
      `archive-extractor: 7z is not supported in portable mode (${path.basename(absPath)}). Please extract manually with 7-Zip and re-import the resulting folder.`,
    );
    return { books: [], tempDir, warnings };
  }

  warnings.push(`archive-extractor: unsupported archive type: ${ext}`);
  return { books: [], tempDir, warnings };
}
