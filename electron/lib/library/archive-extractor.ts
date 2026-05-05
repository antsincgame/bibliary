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
import type { FileHandle } from "fs/promises";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { createRequire } from "module";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { detectExt } from "../scanner/parsers/index.js";
import { SUPPORTED_BOOK_EXTS } from "./types.js";
import { shouldIncludeImportCandidate } from "./import-candidate-filter.js";
import { verifyExtMatchesContent, verifyExtMatchesContentHead } from "./import-magic-guard.js";
import { killChildTree } from "../resilience/kill-tree.js";
/* Phase A+B Iter 9.4 (rev. 2): расширение для торрент-дампов IT-архивов 2000-х.
   tar/gz/bz2/xz — 7zip handle их одинаково через `7z x`. Двойные .tar.gz / .tar.bz2
   распознаются через basename match ниже. */
/* Phase Iter 10.1: поддержка образов дисков.
   ISO/IMG — 7-Zip извлекает нативно (ISO9660 + UDF).
   NRG (Nero Burning ROM) — стриппинг Nero-footer → сырой ISO → передаём 7z. */
const ARCHIVE_EXTS = new Set([
  ".zip", ".cbz", ".rar", ".cbr", ".7z",
  ".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz",
  ".iso", ".img", ".nrg",
]);

/**
 * Phase A+B Iter 9.4: предельный лимит файлов для multi-book архивов.
 * Когда архив явно состоит почти полностью из FB2 (как Флибуста-дампы
 * `f.fb2-XXXXX-YYYYY.zip` со строгими ID-ranges), стандартный лимит 5000
 * приводит к отказу импорта. Мы повышаем его до 100000 ТОЛЬКО для таких
 * архивов после явной проверки доли FB2 в entries.
 */
const FB2_MULTI_BOOK_FILE_LIMIT = 100_000;
const FB2_MULTI_BOOK_RATIO_THRESHOLD = 0.8;
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

/**
 * Audit A10 (Wave2): scan os.tmpdir() для orphan'ов `bibliary-archive-*`,
 * созданных предыдущими crash-сессиями. Best-effort — на любой ошибке
 * молчит. Удаляет ТОЛЬКО директории, имя которых начинается с маркера
 * + старше cutoffMs (default 6 часов = текущая сессия не удаляется).
 *
 * Вызывается из main.ts на startup (не блокирующий).
 */
export async function cleanupOrphanedArchiveTempDirs(cutoffMs = 6 * 60 * 60 * 1000): Promise<{ removed: number; errors: number }> {
  const tmpRoot = os.tmpdir();
  const now = Date.now();
  let removed = 0;
  let errors = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(tmpRoot);
  } catch { return { removed, errors }; }
  for (const name of entries) {
    if (!name.startsWith("bibliary-archive-")) continue;
    const full = path.join(tmpRoot, name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs < cutoffMs) continue;
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } catch { errors++; }
  }
  return { removed, errors };
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
  /* Vendor candidates: per-platform + legacy win32-x64 fallback (Phase 4.2).
     На Linux/macOS vendor/7zip обычно не bundled — npm package 7zip-bin
     ниже cover все платформы. Vendor-папка остаётся для Win-portable, где
     bundled binary гарантирует версию и независимость от user-PATH. */
  const { platformVendorDirsWithLegacy, platformExeName } = require("../platform.js") as typeof import("../platform.js");
  const exeName = platformExeName("7z");
  const vendorRoots: string[] = [];
  for (const subdir of platformVendorDirsWithLegacy()) {
    if (typeof process.resourcesPath === "string") {
      vendorRoots.push(path.join(process.resourcesPath, "vendor", "7zip", subdir));
    }
    vendorRoots.push(path.join(process.cwd(), "vendor", "7zip", subdir));
  }
  for (const root of vendorRoots) {
    const candidate = path.join(root, exeName);
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

/**
 * Hard timeout для 7z процесса. Реальные кейсы:
 * - битый RAR5 с corrupted dictionary → 7z висит навсегда
 * - DJVU/ISO с broken table-of-contents → 7z в бесконечном loop
 * Per-file timeout 4 минуты в import.ts не пробрасывается сюда.
 */
const RUN_7Z_DEFAULT_TIMEOUT_MS = 180_000;

function run7z(
  args: string[],
  signal?: AbortSignal,
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const binary = resolve7zBinary();
  if (!binary) {
    return Promise.reject(new Error("7-Zip binary not found. Set BIBLIARY_7Z_PATH or install bundled 7z-bin binaries."));
  }
  const timeoutMs = opts.timeoutMs ?? RUN_7Z_DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(binary, args, { windowsHide: true });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child, { gracefulMs: 500 });
    }, timeoutMs);
    const onAbort = (): void => {
      /* Iter 14.3: на Windows `child.kill()` посылает SIGTERM, который
         завершает только сам 7z.exe; его поддочерние процессы (если 7z
         запустит worker'ов) могут пережить kill и стать orphans. Tree-kill
         через `taskkill /T /F` гарантированно убирает всё поддерево.
         См. `electron/lib/resilience/kill-tree.ts`. */
      clearTimeout(timer);
      killChildTree(child, { gracefulMs: 500 });
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutChunks.push(String(chunk)); });
    child.stderr.on("data", (chunk) => { stderrChunks.push(String(chunk)); });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      if (timedOut) {
        reject(new Error(`7z timeout after ${timeoutMs}ms: ${(stderr || stdout).slice(0, 200)}`));
        return;
      }
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

  /* Phase A+B Iter 9.4 — fb2.zip multi-book detection.
     Поднимаем лимит файлов до 100000 для архивов где доля FB2 >= 80%
     (Флибуста/Либрусек ежемесячные дампы вроде `f.fb2-725372-725651.zip`).
     Защита от zip-bomb остаётся через MAX_BYTES (5 GB) и MAX_RATIO (100:1). */
  const isFb2MultiBookArchive = (() => {
    if (fileEntries.length < 100) return false;
    let fb2Count = 0;
    for (const e of fileEntries) {
      if (e.name.toLowerCase().endsWith(".fb2")) fb2Count++;
    }
    return fb2Count / fileEntries.length >= FB2_MULTI_BOOK_RATIO_THRESHOLD;
  })();
  const effectiveMaxFiles = isFb2MultiBookArchive
    ? FB2_MULTI_BOOK_FILE_LIMIT
    : limits.maxFiles;
  if (isFb2MultiBookArchive && fileEntries.length > limits.maxFiles) {
    warnings.push(
      `archive-extractor: ${sourceArchive} detected as fb2-multi-book archive (${fileEntries.length} entries, ≥80% FB2); raising file limit to ${FB2_MULTI_BOOK_FILE_LIMIT}`,
    );
  }

  if (fileEntries.length > effectiveMaxFiles) {
    warnings.push(
      `archive-extractor: ${sourceArchive} has ${fileEntries.length} files (>${effectiveMaxFiles} limit) — refused as potential zip-bomb`,
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
  if (compressedBytes > 0 && estimatedTotal > 0) {
    const ratio = estimatedTotal / compressedBytes;
    if (ratio > limits.maxCompressionRatio) {
      warnings.push(
        `archive-extractor: ${sourceArchive} compression ratio ${ratio.toFixed(0)}:1 (>${limits.maxCompressionRatio}:1 limit) — refused as potential zip-bomb`,
      );
      return [];
    }
  } else if (compressedBytes > 0 && estimatedTotal === 0 && fileEntries.length > 0) {
    warnings.push(
      `archive-extractor: ${sourceArchive} — unable to determine uncompressed size for ${fileEntries.length} entries (JSZip API may have changed); refusing as safety measure`,
    );
    return [];
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
      const headForMagic = data.subarray(0, Math.min(32, data.byteLength));
      const magicVerdict = verifyExtMatchesContentHead(ext, headForMagic);
      if (!magicVerdict.ok) {
        warnings.push(`archive-extractor: skipped ${entry.name} in ${sourceArchive}: ${magicVerdict.reason ?? "magic mismatch"}`);
        try { await fs.unlink(out_path); } catch { /* best-effort cleanup */ }
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

/**
 * Nero Burning ROM image stripper.
 *
 * Reads the NRG footer (last ≤12 bytes) to locate where the track data ends,
 * then stream-copies that portion to `destIsoPath` as a raw ISO 9660 image.
 *
 * Supports:
 *   NER5 (v2) — 64-bit footer offset at EOF-12, magic "NER5" at EOF-4
 *   NERO (v1) — 32-bit footer offset at EOF-8,  magic "NERO" at EOF-4
 *
 * Uses 4 MB chunks to handle 700 MB CD images without loading them into memory.
 */
async function nrgStripToIso(
  nrgPath: string,
  destIsoPath: string,
  warnings: string[],
): Promise<boolean> {
  const NRG_CHUNK = 4 * 1024 * 1024;
  let src: FileHandle | null = null;
  let dst: FileHandle | null = null;
  try {
    src = await fs.open(nrgPath, "r");
    const { size } = await src.stat();
    if (size < 16) {
      warnings.push(`archive-extractor: NRG too small to be valid: ${path.basename(nrgPath)}`);
      return false;
    }

    /* Read last 16 bytes to detect magic + footer offset.
       tail layout (bytes relative to EOF):
         tail[12..15] = magic ("NERO" or "NER5")
         tail[8..11]  = NERO 32-bit offset  |  NER5 low 32-bits of 64-bit offset
         tail[4..7]   = NER5 high 32-bits (v2 only)                             */
    const tail = Buffer.allocUnsafe(16);
    await src.read(tail, 0, 16, size - 16);
    const magic = tail.slice(12, 16).toString("ascii");
    let dataEnd: number;

    if (magic === "NER5") {
      const hi = tail.readUInt32BE(4);
      const lo = tail.readUInt32BE(8);
      dataEnd = hi * 0x1_0000_0000 + lo;
    } else if (magic === "NERO") {
      dataEnd = tail.readUInt32BE(8);
    } else {
      warnings.push(
        `archive-extractor: not a valid NRG (magic "${magic}"): ${path.basename(nrgPath)}`,
      );
      return false;
    }

    if (dataEnd <= 0 || dataEnd > size) {
      warnings.push(
        `archive-extractor: NRG footer offset ${dataEnd} out of range (size=${size}): ${path.basename(nrgPath)}`,
      );
      return false;
    }

    dst = await fs.open(destIsoPath, "w");
    const chunk = Buffer.allocUnsafe(NRG_CHUNK);
    let copied = 0;
    while (copied < dataEnd) {
      const toRead = Math.min(NRG_CHUNK, dataEnd - copied);
      const { bytesRead } = await src.read(chunk, 0, toRead, copied);
      if (bytesRead === 0) break;
      await dst.write(chunk, 0, bytesRead);
      copied += bytesRead;
    }
    return copied > 0;
  } catch (err) {
    warnings.push(
      `archive-extractor: NRG strip error for ${path.basename(nrgPath)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    await src?.close().catch(() => {});
    await dst?.close().catch(() => {});
  }
}

async function extractWith7z(
  absPath: string,
  tempDir: string,
  warnings: string[],
  opts: { sourceLabel?: string } = {},
): Promise<ExtractedBook[]> {
  const limits = resolveLimits();
  const sourceArchive = opts.sourceLabel ?? path.basename(absPath);
  let listed;
  try {
    /* -mcu=on: force UTF-8 для file-name output. Старые архивы из Флибусты
       (RAR/ZIP созданные русским WinRAR'ом) могут возвращать имена в CP866/CP1251,
       что при -setEncoding("utf8") даёт `\uFFFD` и теряет файлы. */
    listed = await run7z(["l", "-slt", "-ba", "-mcu=on", absPath]);
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
    await run7z(["x", "-y", "-mcu=on", `-o${tempDir}`, absPath]);
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
      const magicVerdict = await verifyExtMatchesContent(resolved, ext);
      if (!magicVerdict.ok) {
        warnings.push(`archive-extractor: skipped ${path.relative(tempDir, resolved)} in ${sourceArchive}: ${magicVerdict.reason ?? "magic mismatch"}`);
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

  const EXTS_VIA_7Z = new Set([".rar", ".cbr", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz"]);
  if (EXTS_VIA_7Z.has(ext)) {
    const books = await extractWith7z(absPath, tempDir, warnings);
    if (books.length === 0 && warnings.length === 0) {
      warnings.push(`archive-extractor: ${ext.slice(1).toUpperCase()} archive contains no supported book files (${path.basename(absPath)})`);
    }
    return { books, tempDir, warnings };
  }

  /* Phase Iter 10.1 — disk image support.
     ISO/IMG: 7-Zip handles ISO9660 + UDF natively.
     NRG: strip the Nero footer to recover the raw ISO9660 track, then feed to 7z. */
  if (ext === ".iso" || ext === ".img") {
    const books = await extractWith7z(absPath, tempDir, warnings);
    if (books.length === 0 && warnings.length === 0) {
      warnings.push(
        `archive-extractor: ${ext.slice(1).toUpperCase()} image contains no supported book files (${path.basename(absPath)})`,
      );
    }
    return { books, tempDir, warnings };
  }

  if (ext === ".nrg") {
    const baseName = path.basename(absPath, ".nrg");
    const tempIsoPath = path.join(tempDir, sanitizeEntryName(baseName + "__nrg.iso"));
    const stripped = await nrgStripToIso(absPath, tempIsoPath, warnings);
    if (!stripped) {
      warnings.push(
        `archive-extractor: NRG image could not be converted — no books extracted (${path.basename(absPath)})`,
      );
      return { books: [], tempDir, warnings };
    }
    const books = await extractWith7z(tempIsoPath, tempDir, warnings, {
      sourceLabel: path.basename(absPath),
    });
    if (books.length === 0 && warnings.length === 0) {
      warnings.push(
        `archive-extractor: NRG image contains no supported book files (${path.basename(absPath)})`,
      );
    }
    return { books, tempDir, warnings };
  }

  warnings.push(`archive-extractor: unsupported archive type: ${ext}`);
  return { books: [], tempDir, warnings };
}
