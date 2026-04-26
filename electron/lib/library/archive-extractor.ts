/**
 * Archive Extractor — распаковка архивов с книгами в temp-директорию.
 *
 * ZIP / CBZ читаются через JSZip. RAR / CBR / 7z читаются через реальный
 * 7-Zip binary, если он доступен в bundled dependency или `BIBLIARY_7Z_PATH`.
 *
 * Контракт: на выходе массив абсолютных путей к временно распакованным
 * книгам поддерживаемых форматов. Caller (import.ts) скармливает их
 * в обычный pipeline. Чистка temp-папки -- ответственность caller'а
 * через `cleanupExtractedDir(tempDir)`.
 */

import { promises as fs, existsSync } from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { createRequire } from "module";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { detectExt } from "../scanner/parsers/index.js";
import { SUPPORTED_BOOK_EXTS } from "./types.js";
import { shouldIncludeImportCandidate } from "./import-candidate-filter.js";
const ARCHIVE_EXTS = new Set([".zip", ".cbz", ".rar", ".cbr", ".7z"]);
const req = createRequire(path.join(process.cwd(), "package.json"));

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
  await fs.rm(tempDir, { recursive: true, force: true }).catch((err) => console.error("[archive-extractor/cleanup] rm Error:", err));
}

/** Безопасное имя файла для temp -- никаких path traversal из архива. */
function sanitizeEntryName(entryName: string): string {
  const base = path.basename(entryName);
  return base.replace(/[<>:"|?*\x00-\x1F]/g, "_");
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveExistingBinary(candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (candidate === "7z" || candidate === "7za") return candidate;
  return path.isAbsolute(candidate) && requireExists(candidate) ? candidate : null;
}

function requireExists(filePath: string): boolean {
  return existsSync(filePath);
}

function resolve7zBinary(): string | null {
  const env = process.env.BIBLIARY_7Z_PATH?.trim();
  if (env && requireExists(env)) return env;
  const vendorCandidates = [
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "vendor", "7zip", "win32-x64", "7z.exe")
      : "",
    path.join(process.cwd(), "vendor", "7zip", "win32-x64", "7z.exe"),
  ].filter(Boolean);
  for (const candidate of vendorCandidates) {
    if (requireExists(candidate)) return candidate;
  }
  for (const pkg of ["7z-bin", "7zip-bin"]) {
    try {
      const mod = req(pkg) as { path7z?: string; path7za?: string };
      const resolved = resolveExistingBinary(mod.path7z ?? mod.path7za);
      if (resolved) return resolved;
    } catch {
      /* optional helper package is not available */
    }
  }
  return process.platform === "win32" ? null : "7z";
}

function run7z(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const binary = resolve7zBinary();
  if (!binary) {
    return Promise.reject(new Error("7-Zip binary not found. Set BIBLIARY_7Z_PATH or install bundled 7z-bin binaries."));
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const onAbort = (): void => {
      child.kill();
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`7z exited ${code}: ${(stderr || stdout).slice(0, 500)}`));
    });
  });
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
    if (!ext || !(SUPPORTED_BOOK_EXTS as ReadonlySet<string>).has(ext)) continue;
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
      if (
        !shouldIncludeImportCandidate({
          rootDir: tempDir,
          candidatePath: out_path,
          ext,
          sizeBytes: data.byteLength,
        })
      ) {
        continue;
      }
      out.push({ absPath: out_path, entryName: entry.name, sourceArchive });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`archive-extractor: skipped ${entry.name} in ${sourceArchive}: ${msg}`);
    }
  }
  return out;
}

async function extractWith7z(absPath: string, tempDir: string, warnings: string[]): Promise<ExtractedBook[]> {
  const limits = resolveLimits();
  const sourceArchive = path.basename(absPath);
  let listed;
  try {
    listed = await run7z(["l", "-slt", "-ba", absPath]);
  } catch (err) {
    warnings.push(`archive-extractor: 7z list failed for ${sourceArchive}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const entries = parse7zList(listed.stdout)
    .filter((entry) => !entry.isDir)
    .filter((entry) => {
      const ext = detectExt(entry.path);
      return Boolean(ext && (SUPPORTED_BOOK_EXTS as ReadonlySet<string>).has(ext));
    });

  if (entries.length === 0) return [];
  if (entries.some((entry) => path.isAbsolute(entry.path) || entry.path.split(/[\\/]+/).includes(".."))) {
    warnings.push(`archive-extractor: ${sourceArchive} contains unsafe paths — refused`);
    return [];
  }
  if (entries.length > limits.maxFiles) {
    warnings.push(`archive-extractor: ${sourceArchive} has ${entries.length} book files (>${limits.maxFiles} limit) — refused`);
    return [];
  }

  const estimatedTotal = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (estimatedTotal > limits.maxExtractedBytes) {
    const totalGb = (estimatedTotal / 1024 / 1024 / 1024).toFixed(2);
    const limitGb = (limits.maxExtractedBytes / 1024 / 1024 / 1024).toFixed(2);
    warnings.push(`archive-extractor: ${sourceArchive} would extract to ~${totalGb} GB (>${limitGb} GB limit) — refused`);
    return [];
  }

  try {
    await run7z(["x", "-y", `-o${tempDir}`, absPath]);
  } catch (err) {
    warnings.push(`archive-extractor: 7z extract failed for ${sourceArchive}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  return collectExtractedBooks(tempDir, sourceArchive, limits, warnings);
}

async function collectExtractedBooks(
  tempDir: string,
  sourceArchive: string,
  limits: ArchiveLimits,
  warnings: string[],
): Promise<ExtractedBook[]> {
  const out: ExtractedBook[] = [];
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`archive-extractor: cannot read extracted dir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const resolved = path.resolve(full);
      if (!isInside(tempDir, resolved)) {
        warnings.push(`archive-extractor: skipped unsafe extracted path ${full}`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(resolved);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = detectExt(entry.name);
      if (!ext || !(SUPPORTED_BOOK_EXTS as ReadonlySet<string>).has(ext)) continue;
      const stat = await fs.stat(resolved);
      if (
        !shouldIncludeImportCandidate({
          rootDir: tempDir,
          candidatePath: resolved,
          ext,
          sizeBytes: stat.size,
        })
      ) {
        continue;
      }
      totalBytes += stat.size;
      if (out.length >= limits.maxFiles) {
        warnings.push(`archive-extractor: ${sourceArchive} has more than ${limits.maxFiles} extracted book files — truncated`);
        return;
      }
      if (totalBytes > limits.maxExtractedBytes) {
        warnings.push(`archive-extractor: ${sourceArchive} extracted books exceed ${limits.maxExtractedBytes} bytes — truncated`);
        return;
      }
      out.push({
        absPath: resolved,
        entryName: path.relative(tempDir, resolved),
        sourceArchive,
      });
    }
  }

  await walk(tempDir);
  return out;
}

function parse7zList(text: string): Array<{ path: string; size?: number; isDir: boolean }> {
  const entries: Array<{ path: string; size?: number; isDir: boolean }> = [];
  let current: { path?: string; size?: number; attributes?: string } = {};
  const flush = (): void => {
    if (!current.path) return;
    entries.push({
      path: current.path,
      size: current.size,
      isDir: Boolean(current.attributes?.startsWith("D")),
    });
    current = {};
  };
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(" = ");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 3);
    if (key === "Path") {
      flush();
      current.path = value;
    } else if (key === "Size") {
      const n = Number(value);
      if (Number.isFinite(n)) current.size = n;
    } else if (key === "Attributes") {
      current.attributes = value;
    }
  }
  flush();
  return entries;
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

  if (ext === ".rar" || ext === ".cbr" || ext === ".7z") {
    const books = await extractWith7z(absPath, tempDir, warnings);
    if (books.length === 0 && warnings.length === 0) {
      warnings.push(`archive-extractor: ${ext.slice(1).toUpperCase()} archive contains no supported book files (${path.basename(absPath)})`);
    }
    return { books, tempDir, warnings };
  }

  warnings.push(`archive-extractor: unsupported archive type: ${ext}`);
  return { books: [], tempDir, warnings };
}
