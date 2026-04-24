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

/**
 * Anti-zip-bomb hard limits. Применяются ДО записи на диск, чтобы один
 * злонамеренный (или просто гигантский) архив не вынес FS пользователя.
 *
 * Источник цифр:
 *   - 5 GB суммарно — запас в 5x от типового научного архива (1-2 GB
 *     учебники + изображения). Превышение = почти всегда bomb или mistake.
 *   - 5000 файлов — запас в 10x от плотного литературного архива
 *     (типичная подборка по теме = 200-500 файлов).
 *   - Compression ratio 100:1 — классическая bomb-метрика. CBZ
 *     с PNG-страницами даёт 1.5-3:1, текстовые архивы 5-15:1. Всё что
 *     выше 100:1 — флаг подозрения на zip-bomb (классическая
 *     42.zip имеет ratio ~10^9:1).
 *
 * Все три лимита override'ятся через ENV для power-users:
 *   BIBLIARY_ARCHIVE_MAX_BYTES, BIBLIARY_ARCHIVE_MAX_FILES,
 *   BIBLIARY_ARCHIVE_MAX_RATIO.
 */
const DEFAULT_MAX_EXTRACTED_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_COMPRESSION_RATIO = 100;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface ArchiveLimits {
  maxExtractedBytes: number;
  maxFiles: number;
  maxCompressionRatio: number;
}

function resolveLimits(): ArchiveLimits {
  return {
    maxExtractedBytes: readPositiveIntEnv("BIBLIARY_ARCHIVE_MAX_BYTES", DEFAULT_MAX_EXTRACTED_BYTES),
    maxFiles: readPositiveIntEnv("BIBLIARY_ARCHIVE_MAX_FILES", DEFAULT_MAX_FILES),
    maxCompressionRatio: readPositiveIntEnv("BIBLIARY_ARCHIVE_MAX_RATIO", DEFAULT_MAX_COMPRESSION_RATIO),
  };
}

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

  const limits = resolveLimits();
  const sourceArchive = path.basename(absPath);
  const compressedBytes = buf.byteLength;

  /* PRE-CHECK 1: количество файлов. JSZip уже распарсил central directory
     (это дёшево, без распаковки), поэтому total entries известно мгновенно. */
  const allEntries = Object.values(zip.files);
  const fileEntries = allEntries.filter((e) => !e.dir);
  if (fileEntries.length > limits.maxFiles) {
    warnings.push(
      `archive-extractor: ${sourceArchive} has ${fileEntries.length} files (>${limits.maxFiles} limit) — refused as potential zip-bomb`,
    );
    return [];
  }

  /* PRE-CHECK 2: суммарный uncompressed size + compression ratio. Доступно
     до распаковки через `_data.uncompressedSize` (JSZip internal API),
     иначе у больших entries fallback на безопасный 0 — далее тригернёт
     PRE-CHECK 3 при попытке распаковки. */
  let estimatedTotal = 0;
  for (const entry of fileEntries) {
    const internal = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
    const sz = internal?.uncompressedSize;
    if (typeof sz === "number" && sz > 0) estimatedTotal += sz;
  }
  if (estimatedTotal > limits.maxExtractedBytes) {
    const totalGb = (estimatedTotal / 1024 / 1024 / 1024).toFixed(2);
    const limitGb = (limits.maxExtractedBytes / 1024 / 1024 / 1024).toFixed(2);
    warnings.push(
      `archive-extractor: ${sourceArchive} would extract to ~${totalGb} GB (>${limitGb} GB limit) — refused`,
    );
    return [];
  }
  /* compression ratio имеет смысл только когда compressedBytes > 0 и мы
     знаем суммарный uncompressed. */
  if (compressedBytes > 0 && estimatedTotal > 0) {
    const ratio = estimatedTotal / compressedBytes;
    if (ratio > limits.maxCompressionRatio) {
      warnings.push(
        `archive-extractor: ${sourceArchive} compression ratio ${ratio.toFixed(0)}:1 (>${limits.maxCompressionRatio}:1 limit) — refused as potential zip-bomb`,
      );
      return [];
    }
  }

  const out: ExtractedBook[] = [];
  const seen = new Set<string>();
  let extractedSoFar = 0;

  for (const entry of fileEntries) {
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
      /* RUNTIME-CHECK 3: даже если PRE-CHECK 2 прошёл (estimatedTotal=0
         для часть entries), здесь мы знаем точный uncompressed размер. */
      extractedSoFar += data.byteLength;
      if (extractedSoFar > limits.maxExtractedBytes) {
        const gb = (extractedSoFar / 1024 / 1024 / 1024).toFixed(2);
        const limitGb = (limits.maxExtractedBytes / 1024 / 1024 / 1024).toFixed(2);
        warnings.push(
          `archive-extractor: aborted ${sourceArchive} after extracting ${gb} GB (>${limitGb} GB limit) — partial result`,
        );
        break;
      }
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
