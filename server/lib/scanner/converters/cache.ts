/**
 * Converter Cache — on-disk кеш результатов конвертации (Calibre / CBZ / multi-TIFF).
 *
 * Зачем: повторный импорт того же файла (например при редактировании метаданных,
 * перезапуске impor pipeline после ошибки) не требует повторной конвертации.
 * Calibre на 50 MB MOBI = 30+ секунд + heavy lane lock. CBZ→PDF на 500 страниц
 * = ~30 сек + 200 MB RAM. Cache избавляет от дублирующей работы.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Key = sha256(srcPath + mtime + ext) — гарантирует invalidation при
 *     изменении файла (mtime change) или переименовании (path change).
 *   - Value = converted file (.epub / .pdf) в `<cacheDir>/<sha>.<ext>`.
 *   - Storage: `<projectRoot>/data/converters-cache/` по умолчанию,
 *     override через `BIBLIARY_CONVERTER_CACHE_DIR` env (системная настройка
 *     путей — не относится к pipeline-tunables, оставлена).
 *   - Eviction: LRU при превышении max bytes. Конфиг — `prefs.converterCacheMaxBytes`
 *     (Settings UI, default 5 GB). Иt 8В.CRITICAL.2: env удалён.
 *   - Atomic writes: tmpFile → rename, чтобы не получить partial cache entry
 *     при abort/crash в середине.
 *
 *   API:
 *     getCachedConvert(srcPath, ext): { kind: "delegate", path, ext, ... } | null
 *     setCachedConvert(srcPath, ext, srcConvertedPath, outExt): copies file into cache
 *     clearConverterCache(): clears all cache (для тестов и manual reset)
 *
 *   Caller контракт:
 *     1. Перед expensive convert — проверить getCachedConvert. Если hit → использовать.
 *     2. После успешного convert — вызвать setCachedConvert чтобы сохранить.
 *     3. Cache hit возвращает delegate-кid с временным путём — caller НЕ удаляет
 *        cached file (cleanup() = noop). Eviction делает этот modul.
 */

import { promises as fs, existsSync } from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { readPipelinePrefsOrNull } from "../_vendor/preferences/store.js";

export interface CachedConvertResult {
  kind: "delegate";
  /** Путь к cached файлу. Caller НЕ должен удалять — cleanup() = noop. */
  path: string;
  ext: string;
  warnings: string[];
  cleanup: () => Promise<void>;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

function resolveDataDir(): string {
  /* Совпадает с pattern из ocr-cache.ts — без прямой Electron зависимости. */
  const env = process.env["BIBLIARY_CONVERTER_CACHE_DIR"]?.trim();
  if (env) return env;
  /* Default: <cwd>/data/converters-cache (для разработки и тестов).
     В Electron production пути могут override через env при init. */
  return path.join(process.cwd(), "data", "converters-cache");
}

async function ensureCacheDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Compute cache key из srcPath + mtime + ext. mtime гарантирует invalidation
 * при изменении файла даже если path тот же.
 */
async function computeCacheKey(srcPath: string, ext: string): Promise<string> {
  const stat = await fs.stat(srcPath);
  const hash = crypto.createHash("sha256");
  hash.update(srcPath);
  hash.update("|");
  hash.update(String(stat.mtimeMs));
  hash.update("|");
  hash.update(String(stat.size));
  hash.update("|");
  hash.update(ext.toLowerCase());
  return hash.digest("hex");
}

export interface ConverterCacheOptions {
  /** Override cache dir (тесты). Default: $BIBLIARY_CONVERTER_CACHE_DIR or <cwd>/data/converters-cache. */
  cacheDir?: string;
}

/**
 * Получить cached конвертацию если есть.
 * Возвращает null если miss или ошибка чтения cache.
 */
export async function getCachedConvert(
  srcPath: string,
  ext: string,
  outExt: "epub" | "pdf" | "txt",
  opts: ConverterCacheOptions = {},
): Promise<CachedConvertResult | null> {
  const cacheDir = opts.cacheDir ?? resolveDataDir();

  let key: string;
  try {
    key = await computeCacheKey(srcPath, ext);
  } catch {
    return null; /* file gone, cache miss */
  }

  const cachedPath = path.join(cacheDir, `${key}.${outExt}`);
  if (!existsSync(cachedPath)) return null;

  /* Touch atime для LRU. fs.utimes сохраняет mtime, обновляет atime. */
  try {
    const now = new Date();
    const stat = await fs.stat(cachedPath);
    await fs.utimes(cachedPath, now, stat.mtime);
  } catch {
    /* Не критично — продолжаем. */
  }

  return {
    kind: "delegate",
    path: cachedPath,
    ext: outExt,
    warnings: [`converter cache hit (${outExt}) for ${path.basename(srcPath)}`],
    cleanup: async () => undefined, /* НЕ удаляем cached файл. */
  };
}

/**
 * Скопировать converted файл в cache. Идемпотентно — если уже есть, no-op.
 *
 * Atomic write через rename: сначала пишем в .tmp, потом rename. Это защищает
 * от частичного cache entry при abort/crash в середине copy.
 */
export async function setCachedConvert(
  srcPath: string,
  ext: string,
  convertedFilePath: string,
  outExt: "epub" | "pdf" | "txt",
  opts: ConverterCacheOptions = {},
): Promise<void> {
  const cacheDir = opts.cacheDir ?? resolveDataDir();

  let key: string;
  try {
    key = await computeCacheKey(srcPath, ext);
  } catch {
    return; /* nothing to cache */
  }

  await ensureCacheDir(cacheDir);
  const finalPath = path.join(cacheDir, `${key}.${outExt}`);
  if (existsSync(finalPath)) return; /* уже cached */

  /* C3 fix (2026-05-04, /imperor): добавляем 8-байтный crypto-random к
   * tmp-имени. Раньше было только PID + ms — при параллельном импорте
   * двух книг с одного PID в один тик две операции получали одинаковое
   * имя tmp-файла → коллизия (особенно злая на NTFS из-за file lock). */
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    await fs.copyFile(convertedFilePath, tmpPath);
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    console.warn("[converters/cache] setCachedConvert failed:", err);
  }

  /* После записи — проверим LRU eviction. Async fire-and-forget
     (не блокируем caller, eviction lazy). */
  void evictIfOverLimit(cacheDir);
}

/**
 * LRU eviction: удалить oldest-accessed файлы пока total bytes > max.
 * Async fire-and-forget — caller не ждёт.
 *
 * Приоритет maxBytes (Иt 8В.CRITICAL.2 — env удалён):
 *   1. prefs.converterCacheMaxBytes — single source of truth.
 *   2. DEFAULT_MAX_BYTES (5 GB) — fallback если store не инициализирован.
 */
async function evictIfOverLimit(cacheDir: string): Promise<void> {
  const prefs = await readPipelinePrefsOrNull();
  const maxBytes = typeof prefs?.converterCacheMaxBytes === "number"
    ? prefs.converterCacheMaxBytes
    : DEFAULT_MAX_BYTES;
  /* maxBytes === 0 → отключено (без лимита). */
  if (maxBytes <= 0) return;

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }

  const stats: { name: string; absPath: string; size: number; atimeMs: number }[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".tmp-")) continue; /* skip in-progress writes */
    const abs = path.join(cacheDir, entry.name);
    try {
      const st = await fs.stat(abs);
      stats.push({ name: entry.name, absPath: abs, size: st.size, atimeMs: st.atimeMs });
      totalBytes += st.size;
    } catch {
      /* skip unreadable */
    }
  }

  if (totalBytes <= maxBytes) return;

  /* Sort by atime ascending (oldest first), удаляем до целевого размера. */
  stats.sort((a, b) => a.atimeMs - b.atimeMs);

  for (const entry of stats) {
    if (totalBytes <= maxBytes) break;
    try {
      await fs.unlink(entry.absPath);
      totalBytes -= entry.size;
    } catch (err) {
      console.warn("[converters/cache] evict failed:", err);
    }
  }
}

/**
 * Полная очистка cache (для тестов и manual user reset).
 */
export async function clearConverterCache(opts: ConverterCacheOptions = {}): Promise<void> {
  const cacheDir = opts.cacheDir ?? resolveDataDir();
  if (!existsSync(cacheDir)) return;
  try {
    const entries = await fs.readdir(cacheDir);
    await Promise.all(entries.map((e) => fs.unlink(path.join(cacheDir, e)).catch(() => undefined)));
  } catch (err) {
    console.warn("[converters/cache] clear failed:", err);
  }
}

/**
 * Текущий total bytes в cache (для тестов и UI).
 */
export async function getCacheStats(opts: ConverterCacheOptions = {}): Promise<{ files: number; bytes: number }> {
  const cacheDir = opts.cacheDir ?? resolveDataDir();
  if (!existsSync(cacheDir)) return { files: 0, bytes: 0 };

  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const st = await fs.stat(path.join(cacheDir, entry.name));
        files++;
        bytes += st.size;
      } catch {
        /* skip */
      }
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}
