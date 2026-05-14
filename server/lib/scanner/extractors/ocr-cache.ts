/**
 * OCR Cache — file-based кеш результатов OCR.
 *
 * ПРОБЛЕМА БЕЗ КЕША:
 *   - Re-import той же DjVu/PDF/CBZ книги (например, после `library-rebuild`)
 *     заставляет heavy OCR запускаться заново — минуты на vision-LLM, секунды
 *     на system OCR per page.
 *   - Per-page routing (Tier 0/1/2 cascade) тоже выгоднее с кешем: страница
 *     один раз распознанная как «сложный шрифт → vision-LLM» не должна
 *     повторно тратить vision модель.
 *
 * РЕШЕНИЕ:
 *   Cache key = sha256(fileSha256 + ":" + pageIndex + ":" + engine).
 *   Storage: `app-data/ocr-cache/<keyPrefix>/<keyFull>.json`.
 *   Каждая запись содержит engine, quality score, text, createdAt.
 *
 * ИНВАЛИДАЦИЯ:
 *   - Автоматическая: при смене engine для той же страницы — новый key, старый
 *     остаётся (не trash, может пригодиться при сравнении).
 *   - Ручная: `clearAll()` для диагностики / settings.
 *   - НЕ инвалидируем по mtime файла — вместо этого требуем sha256 от caller'а
 *     (это даёт гарантию: одинаковый контент → одинаковый кеш).
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Кеш НЕ знает что такое DjVu/PDF/CBZ — оперирует абстрактным fileSha + page + engine.
 *   - Кеш НЕ выполняет OCR — только хранит результат, вызванный caller'ом.
 *   - Best-effort: ошибки I/O не падают, только логируются. Cache miss безопасен.
 */

import { promises as fs, existsSync } from "fs";
import * as path from "path";
import { createHash } from "crypto";

/**
 * Tier-1a "tesseract" добавлен в PR #2 (Tier-1a Tesseract.js for solid Cyrillic OCR).
 * Cascade order: text-layer → tesseract → system-ocr → vision-llm.
 * Cache key включает engine, поэтому новый литерал не пересекается со старыми
 * записями (system-ocr / vision-llm) — re-import пересчитывает Tesseract отдельно.
 */
export type OcrEngine = "text-layer" | "tesseract" | "system-ocr" | "vision-llm";

export interface OcrCacheEntry {
  engine: OcrEngine;
  /** Quality score 0..1 (см. quality-heuristic.ts). Помогает caller решить, нужен ли retry с другим engine. */
  quality: number;
  text: string;
  /** ISO-8601 timestamp создания записи. */
  createdAt: string;
}

export interface OcrCacheOptions {
  /** Каталог хранения. По умолчанию — `<projectRoot>/data/ocr-cache/` или `$BIBLIARY_DATA_DIR/ocr-cache/`. */
  cacheDir?: string;
}

let resolvedCacheDir: string | null = null;

/** Разрешение data dir по той же стратегии что library/paths.ts: BIBLIARY_DATA_DIR → projectRoot/data. */
function resolveDataDir(): string {
  const fromEnv = process.env.BIBLIARY_DATA_DIR?.trim();
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  /* Поиск projectRoot: cwd-first, поднимаемся до package.json. */
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json"))) return path.join(dir, "data");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), "data");
}

function getCacheDir(opts: OcrCacheOptions = {}): string {
  if (opts.cacheDir) return opts.cacheDir;
  if (resolvedCacheDir) return resolvedCacheDir;
  resolvedCacheDir = path.join(resolveDataDir(), "ocr-cache");
  return resolvedCacheDir;
}

function buildKey(fileSha256: string, pageIndex: number, engine: OcrEngine): string {
  return createHash("sha256")
    .update(`${fileSha256}:${pageIndex}:${engine}`)
    .digest("hex");
}

function entryPath(cacheDir: string, key: string): string {
  /* Двухуровневое разбиение по 2 hex-символам — не больше 256 файлов в одной папке
     даже на терабайтных каталогах. ext4/ntfs справляются и с миллионами, но
     листинг такой папки в любом проводнике становится мукой. */
  return path.join(cacheDir, key.slice(0, 2), `${key}.json`);
}

/**
 * Прочитать запись из кеша. Возвращает null если miss или I/O ошибка.
 *
 * Best-effort: повреждённый JSON, отсутствующий файл — все silently → null.
 * Cache miss НЕ должен ломать pipeline.
 */
export async function getCachedOcr(
  fileSha256: string,
  pageIndex: number,
  engine: OcrEngine,
  opts: OcrCacheOptions = {},
): Promise<OcrCacheEntry | null> {
  if (!fileSha256 || pageIndex < 0) return null;
  try {
    const cacheDir = getCacheDir(opts);
    const key = buildKey(fileSha256, pageIndex, engine);
    const filePath = entryPath(cacheDir, key);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<OcrCacheEntry>;
    if (
      typeof parsed.engine === "string" &&
      typeof parsed.text === "string" &&
      typeof parsed.quality === "number" &&
      typeof parsed.createdAt === "string"
    ) {
      return parsed as OcrCacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Сохранить результат OCR в кеш. Best-effort: ошибки I/O логируются, не throw.
 */
export async function setCachedOcr(
  fileSha256: string,
  pageIndex: number,
  entry: OcrCacheEntry,
  opts: OcrCacheOptions = {},
): Promise<void> {
  if (!fileSha256 || pageIndex < 0 || !entry.text) return;
  try {
    const cacheDir = getCacheDir(opts);
    const key = buildKey(fileSha256, pageIndex, entry.engine);
    const filePath = entryPath(cacheDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(entry), "utf8");
  } catch (err) {
    console.warn("[ocr-cache] setCachedOcr failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Удалить ВСЕ записи кеша (для диагностики / settings).
 */
export async function clearOcrCache(opts: OcrCacheOptions = {}): Promise<number> {
  try {
    const cacheDir = getCacheDir(opts);
    let removed = 0;
    let entries;
    try {
      entries = await fs.readdir(cacheDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdir = path.join(cacheDir, entry.name);
      const files = await fs.readdir(subdir).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        await fs.unlink(path.join(subdir, f)).then(() => { removed += 1; }).catch(() => undefined);
      }
    }
    return removed;
  } catch (err) {
    console.warn("[ocr-cache] clearOcrCache failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

/* NB: Resolved cacheDir cache (resolvedCacheDir) намеренно не имеет публичного
   reset hook — тесты используют opts.cacheDir override напрямую (см.
   tests/extractors-cache.test.ts). Это даёт изоляцию без shared state. */
