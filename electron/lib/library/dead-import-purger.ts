/**
 * Dead Import Purger — sweep битых импортированных книг при запуске или по
 * запросу пользователя.
 *
 * Зачем:
 *   До v1.0.2 magic-guard был выключен (по неверному решению Imperor 2026-05-04),
 *   и в каталог попадали 100+ файлов с размером в десятки MB но содержимым
 *   из одного байта 0xFF (incomplete BitTorrent download). Парсер падал,
 *   книги получали `status: unsupported`, evaluator их пропускал, reader
 *   показывал пустую страницу — UX-катастрофа. Этот модуль чистит уже
 *   импортированный мусор и освобождает диск (~ГБ).
 *
 * Контракт:
 *   - Сканирует ТОЛЬКО книги со `status === "unsupported"`. Imported и evaluated
 *     не трогает (даже если original битый — это была бы регрессия).
 *   - Для каждой кандидата вычисляет original file path (legacy + modern
 *     sidecars), проверяет байты через `detectIncompleteFile`. Только при
 *     `valid: false` → удаляет.
 *   - Удаление: `deleteBook(id)` (cache-db) + best-effort удаление sidecar
 *     файлов и пустого bookDir. CAS-блобы и Chroma НЕ трогает (orphan-cleanup
 *     отдельная задача — уже есть в `library:burn-library` пути; здесь
 *     не дублируем чтобы не задерживать sweep).
 *   - Идемпотентно: повторный вызов на чистой DB → `{ scanned: 0, purged: 0 }`.
 *   - Ничего не throw'ит наружу; ошибки на одной книге — warning + продолжение.
 *
 * Производительность:
 *   - Только unsupported книги (обычно <1% от общего каталога).
 *   - Каждая проверка = 16KB чтения original (4 пробы по 4KB).
 *   - Одна транзакция SQLite на книгу (deleteBook).
 *   - Sequential — не параллелим, чтобы не нагружать диск во время bootstrap.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { streamBookIdsByStatus, getBooksByIds, deleteBook } from "./cache-db.js";
import {
  resolveLegacySidecarPaths,
  resolveSidecarPaths,
} from "./storage-contract.js";
import { detectIncompleteFile } from "../scanner/file-validity.js";
import type { BookCatalogMeta } from "./types.js";

const PAGE_SIZE = 200;

export interface PurgeResult {
  /** Всего проверено unsupported-книг. */
  scanned: number;
  /** Удалено как incomplete-import. */
  purged: number;
  /** Пропущено (original найден и валиден — например, реальный DRM PDF). */
  skipped: number;
  /** Книг где original не нашёлся на диске (catalog stale). */
  missing: number;
  /** Свободно дискового пространства в байтах (сумма размеров удалённых originals). */
  freedBytes: number;
  /** Список удалённых: id + title + reason для лога/UI. */
  purgedDetails: Array<{ id: string; title: string; reason: string; bytes: number }>;
}

/**
 * Resolve paths to BOTH legacy and modern sidecar layouts. Returns first one
 * whose original file exists on disk; if neither, returns the path that the
 * catalog meta points to (so caller can report `missing`).
 */
async function resolveExistingOriginalPath(meta: BookCatalogMeta & { mdPath: string }): Promise<{
  originalPath: string;
  bookDir: string;
  metaPath: string;
  illustrationsPath: string;
  found: boolean;
}> {
  const legacy = resolveLegacySidecarPaths(meta.mdPath, meta.originalFile, meta.originalFormat);
  try {
    await fs.access(legacy.originalPath);
    return { ...legacy, found: true };
  } catch {
    /* try modern layout below */
  }
  const modern = resolveSidecarPaths(meta.mdPath, meta.originalFormat);
  try {
    await fs.access(modern.originalPath);
    return { ...modern, found: true };
  } catch {
    return { ...legacy, found: false };
  }
}

async function tryUnlink(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    await fs.unlink(p);
    return Number(st.size) || 0;
  } catch {
    return 0;
  }
}

async function tryRmdir(dir: string): Promise<void> {
  try {
    /* Only remove empty dir; ignore ENOTEMPTY. */
    await fs.rmdir(dir);
  } catch {
    /* swallow */
  }
}

async function purgeOneBook(
  meta: BookCatalogMeta & { mdPath: string },
  result: PurgeResult,
): Promise<void> {
  const paths = await resolveExistingOriginalPath(meta);
  if (!paths.found) {
    result.missing += 1;
    /* Catalog row references missing file. Still delete the row so it doesn't
       clutter UI. mdPath may also be gone — that's fine, we tolerate ENOENT. */
    try {
      const mdSize = await tryUnlink(meta.mdPath);
      deleteBook(meta.id);
      result.purged += 1;
      result.freedBytes += mdSize;
      result.purgedDetails.push({
        id: meta.id,
        title: meta.title || "(untitled)",
        reason: "catalog row references missing file",
        bytes: mdSize,
      });
    } catch (err) {
      console.warn(`[purger] delete-row failed for ${meta.id}:`, (err as Error).message);
    }
    return;
  }

  const verdict = await detectIncompleteFile(paths.originalPath);
  if (verdict.valid) {
    /* Original is real — leave it alone (might be DRM-protected PDF, exotic
       format the parser doesn't support, etc.). User can manually delete via UI. */
    result.skipped += 1;
    return;
  }

  /* Confirmed dead import — delete catalog row + all sidecars + try empty dir. */
  let bytes = 0;
  bytes += await tryUnlink(paths.originalPath);
  bytes += await tryUnlink(meta.mdPath);
  bytes += await tryUnlink(paths.metaPath);
  bytes += await tryUnlink(paths.illustrationsPath);
  await tryRmdir(paths.bookDir);

  try {
    deleteBook(meta.id);
  } catch (err) {
    console.warn(`[purger] deleteBook failed for ${meta.id}:`, (err as Error).message);
    return;
  }

  result.purged += 1;
  result.freedBytes += bytes;
  result.purgedDetails.push({
    id: meta.id,
    title: meta.title || "(untitled)",
    reason: verdict.reason || "incomplete file",
    bytes,
  });
}

/**
 * Sweep всех `unsupported` книг и удалить те, чей original — incomplete-torrent
 * или uniform-garbage. Безопасен для повторных вызовов.
 *
 * Aborts через signal (полезно при shutdown). Не throw'ит — все ошибки
 * сводятся в `result.skipped` и логи.
 */
export async function purgeDeadImports(opts: { signal?: AbortSignal } = {}): Promise<PurgeResult> {
  const result: PurgeResult = {
    scanned: 0,
    purged: 0,
    skipped: 0,
    missing: 0,
    freedBytes: 0,
    purgedDetails: [],
  };

  let cursor: string | null = null;
  while (true) {
    if (opts.signal?.aborted) break;
    const { ids, nextCursor } = streamBookIdsByStatus(["unsupported"], PAGE_SIZE, cursor);
    if (ids.length === 0) break;

    const rows = getBooksByIds(ids);
    for (const meta of rows) {
      if (opts.signal?.aborted) break;
      result.scanned += 1;
      try {
        await purgeOneBook(meta, result);
      } catch (err) {
        console.warn(`[purger] book ${meta.id} failed:`, (err as Error).message);
        result.skipped += 1;
      }
    }

    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return result;
}
