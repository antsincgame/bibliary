/**
 * IPC-handler'ы для каталога библиотеки: чтение, коллекции, удаление, rebuild.
 *
 * Каналы:
 *   library:catalog | tag-stats
 *   library:collection-by-{domain,author,year,sphere,tag}
 *   library:get-book | read-book-md | delete-book | rebuild-cache
 *
 * Извлечено из `library.ipc.ts` (Phase 3.1 cross-platform roadmap, 2026-04-30).
 */

import { ipcMain, shell } from "electron";
import { promises as fs } from "fs";
import {
  query as queryCache,
  getBookById,
  deleteBook as dbDeleteBook,
  rebuildFromFs,
  pruneMissing,
  getCacheDbPath,
  closeCacheDb,
  queryTagStats,
  queryByDomain,
  queryByAuthor,
  queryByYear,
  queryBySphere,
  queryByTag,
  type CatalogQuery,
  type CollectionGroup,
} from "../lib/library/cache-db.js";
import { resolveLibraryRoot } from "../lib/library/paths.js";
import {
  resolveCatalogSidecarPaths,
  resolveLegacySidecarPaths,
  resolveSidecarPaths,
} from "../lib/library/storage-contract.js";
import * as path from "path";
import { unregisterFromNearDup, resetNearDupCache } from "../lib/library/near-dup-detector.js";
import { resetRevisionDedupCache } from "../lib/library/revision-dedup.js";
import { parseFrontmatter } from "../lib/library/md-converter.js";
import type { BookCatalogMeta } from "../lib/library/types.js";

/**
 * Iter 13.2 (P6): удаляет пустые директории СНИЗУ ВВЕРХ от `startDir` до
 * `stopAt` (исключительно). Безопасно для соседних книг: rmdir БЕЗ recursive
 * означает что dir с любыми остатками (другие .md, .blobs, посторонние)
 * выживает.
 *
 * Зачем: после удаления sidecars одной книги, её bookDir может стать пустым,
 * и тогда родитель `<author>/` может стать пустым, и `<domain>/` тоже. Без
 * cascade-prune после массового delete остаётся скелет вложенных пустых
 * папок. Возвращает количество удалённых директорий для UI-summary.
 */
async function pruneEmptyDirsUpwards(startDir: string, stopAt: string): Promise<number> {
  const root = path.resolve(stopAt);
  let cursor = path.resolve(startDir);
  let removed = 0;
  while (cursor !== root && cursor.startsWith(root) && cursor.length > root.length) {
    let entries: string[];
    try {
      entries = await fs.readdir(cursor);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    try {
      await fs.rmdir(cursor);
      removed += 1;
    } catch {
      break;
    }
    cursor = path.dirname(cursor);
  }
  return removed;
}

/**
 * Iter 13.2 (P6): рекурсивный подсчёт файлов и директорий перед burn-all.
 * Возвращает суммарную статистику дерева, чтобы UI мог показать
 * "удалено N файлов в M папках". Best-effort: пропускает недоступные
 * элементы и не бросает.
 */
async function countTreeEntries(
  root: string,
): Promise<{ files: number; dirs: number }> {
  let files = 0;
  let dirs = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs += 1;
        stack.push(full);
      } else {
        files += 1;
      }
    }
  }
  return { files, dirs };
}

export function registerLibraryCatalogIpc(): void {
  ipcMain.handle(
    "library:catalog",
    async (
      _e,
      args: CatalogQuery = {}
    ): Promise<{ rows: BookCatalogMeta[]; total: number; libraryRoot: string; dbPath: string }> => {
      const result = queryCache(args);
      return {
        rows: result.rows,
        total: result.total,
        libraryRoot: resolveLibraryRoot(),
        dbPath: getCacheDbPath(),
      };
    }
  );

  ipcMain.handle("library:tag-stats", (_e, locale?: string): { tag: string; count: number }[] => {
    const loc = locale === "ru" ? "ru" : "en";
    return queryTagStats(loc);
  });

  ipcMain.handle("library:collection-by-domain", (): CollectionGroup[] => {
    return queryByDomain();
  });

  ipcMain.handle("library:collection-by-author", (_e, locale?: string): CollectionGroup[] => {
    const loc = locale === "ru" ? "ru" : "en";
    return queryByAuthor(loc);
  });

  ipcMain.handle("library:collection-by-year", (): CollectionGroup[] => {
    return queryByYear();
  });

  ipcMain.handle("library:collection-by-sphere", (): CollectionGroup[] => {
    return queryBySphere();
  });

  ipcMain.handle("library:collection-by-tag", (_e, locale?: string): CollectionGroup[] => {
    const loc = locale === "ru" ? "ru" : "en";
    return queryByTag(loc);
  });

  ipcMain.handle(
    "library:get-book",
    async (_e, bookId: string): Promise<(BookCatalogMeta & { mdPath: string }) | null> => {
      if (typeof bookId !== "string") return null;
      return getBookById(bookId);
    }
  );

  ipcMain.handle(
    "library:read-book-md",
    async (_e, bookId: string): Promise<{ markdown: string; mdPath: string } | null> => {
      if (typeof bookId !== "string") return null;
      const meta = getBookById(bookId);
      if (!meta) return null;
      try {
        const markdown = await fs.readFile(meta.mdPath, "utf-8");
        return { markdown, mdPath: meta.mdPath };
      } catch (e) {
        console.warn(`[library:read-book-md] ${bookId}:`, e instanceof Error ? e.message : e);
        return null;
      }
    }
  );

  /**
   * Iter 12 P2.1: open original book file via OS handler.
   * Возвращает ok=true если shell.openPath отработал, иначе reason.
   */
  ipcMain.handle(
    "library:open-original",
    async (_e, bookId: string): Promise<{ ok: boolean; reason?: string }> => {
      if (typeof bookId !== "string") return { ok: false, reason: "bookId required" };
      const meta = getBookById(bookId);
      if (!meta) return { ok: false, reason: "not-found" };
      try {
        const sidecars = await resolveCatalogSidecarPaths(meta);
        const result = await shell.openPath(sidecars.originalPath);
        if (result) return { ok: false, reason: result };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /**
   * Iter 12 P2.1: reveal book directory в системном проводнике.
   */
  ipcMain.handle(
    "library:reveal-in-folder",
    async (_e, bookId: string): Promise<{ ok: boolean; reason?: string }> => {
      if (typeof bookId !== "string") return { ok: false, reason: "bookId required" };
      const meta = getBookById(bookId);
      if (!meta) return { ok: false, reason: "not-found" };
      try {
        const sidecars = await resolveCatalogSidecarPaths(meta);
        shell.showItemInFolder(sidecars.originalPath);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /**
   * Lightweight cover URL probe для catalog thumbnail.
   * Image-refs в book.md находятся в КОНЦЕ файла (buildImageRefs в md-converter).
   * Стратегия: читаем последние 4 KB (tail) — там гарантированно [img-cover]: URL
   * для всех книг стандартного формата. Fallback: первые 4 KB для legacy base64.
   * Вызывается через IntersectionObserver per-row только когда thumb виден.
   */
  ipcMain.handle(
    "library:get-cover-url",
    async (_e, bookId: string): Promise<string | null> => {
      if (typeof bookId !== "string") return null;
      const meta = getBookById(bookId);
      if (!meta) return null;
      try {
        const fh = await fs.open(meta.mdPath, "r");
        try {
          const CHUNK = 4 * 1024;
          const stat = await fh.stat();
          const fileSize = stat.size;

          /* Читаем хвост файла — там всегда image refs секция. */
          const tailOffset = Math.max(0, fileSize - CHUNK);
          const tailBuf = Buffer.alloc(Math.min(CHUNK, fileSize));
          const { bytesRead: tailRead } = await fh.read(tailBuf, 0, tailBuf.length, tailOffset);
          const tail = tailBuf.slice(0, tailRead).toString("utf-8");
          const cas = tail.match(/^\[img-cover\]:\s*(bibliary-asset:\/\/sha256\/[a-f0-9]{64})\s*$/m);
          if (cas) return cas[1];

          /* Fallback: читаем голову для legacy base64 Data URI. */
          if (fileSize > CHUNK) {
            const headBuf = Buffer.alloc(CHUNK);
            const { bytesRead: headRead } = await fh.read(headBuf, 0, headBuf.length, 0);
            const head = headBuf.slice(0, headRead).toString("utf-8");
            const b64 = head.match(/^\[img-cover\]:\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\s*$/m);
            if (b64) return b64[1];
          } else {
            /* Маленький файл — tail уже содержит всё содержимое. */
            const b64 = tail.match(/^\[img-cover\]:\s*(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\s*$/m);
            if (b64) return b64[1];
          }
          return null;
        } finally {
          await fh.close();
        }
      } catch (e) {
        console.warn(`[library:get-cover-url] ${bookId}:`, e instanceof Error ? e.message : e);
        return null;
      }
    }
  );

  ipcMain.handle(
    "library:delete-book",
    async (_e, args: {
      bookId: string;
      deleteFiles?: boolean;
      /** Иt 8Е.1 (hybrid cascade): активная коллекция в renderer (если выбрана).
       *  Sync-удаление точек этой книги ДО возврата (быстро, ~50ms). */
      activeCollection?: string;
    }): Promise<{ ok: boolean; reason?: string; chromaCleaned?: number; chromaBackgroundScheduled?: boolean; filesRemoved?: number; dirsRemoved?: number }> => {
      if (!args || typeof args.bookId !== "string") return { ok: false, reason: "bookId required" };
      const meta = getBookById(args.bookId);
      if (!meta) return { ok: false, reason: "not-found" };
      let filesRemoved = 0;
      let dirsRemoved = 0;
      try {
        dbDeleteBook(args.bookId);
        /* Снимаем книгу с near-dup tracker'а, иначе следующий импорт
           похожей книги получит ложное предупреждение «near-duplicate of
           {удалённый-id}». Идемпотентно. */
        unregisterFromNearDup(meta);
        resetRevisionDedupCache();
        if (args.deleteFiles !== false) {
          /* Iter 13.2 (P6 root cause fix): объединяем legacy + modern наборы
             sidecar-путей. Раньше resolveCatalogSidecarPaths выбирал ОДИН
             набор по эвристике `access(legacy.original.{fmt})` — если в
             папке оставался посторонний `original.pdf` (от старого импорта),
             handler удалял meta.json/illustrations.json по legacy-именам, а
             modern `{Title}.original.pdf` + `{Title}.meta.json` оставались
             на диске. Книга исчезала из UI, но `data/library/` пухло.
             Теперь пробуем ОБА набора имён + оригинальное `meta.mdPath` —
             всё `force: true`, безопасно для отсутствующих файлов. */
          const sidecarsLegacy = resolveLegacySidecarPaths(
            meta.mdPath,
            (meta as { originalFile?: string }).originalFile,
            meta.originalFormat,
          );
          const sidecarsModern = resolveSidecarPaths(meta.mdPath, meta.originalFormat);
          const toDelete = new Set<string>([
            meta.mdPath,
            sidecarsLegacy.originalPath,
            sidecarsLegacy.metaPath,
            sidecarsLegacy.illustrationsPath,
            sidecarsModern.originalPath,
            sidecarsModern.metaPath,
            sidecarsModern.illustrationsPath,
          ]);
          for (const p of toDelete) {
            try {
              await fs.stat(p);
              await fs.rm(p, { force: true });
              filesRemoved += 1;
            } catch {
              /* Файла нет — это нормально (legacy/modern имена пересекаются). */
            }
          }
          /* Cleanup пустых папок снизу вверх до libraryRoot (или первой
             непустой). Раньше использовали один rmdir(bookDir) без
             recursive — `data/library/<lang>/<domain>/<author>/` могла
             остаться полупустой пирамидой даже если книга была единственной.
             Идём от bookDir вверх, удаляя ТОЛЬКО пустые dirs (rmdir без
             recursive — единственный безопасный способ не снести соседей). */
          dirsRemoved += await pruneEmptyDirsUpwards(
            sidecarsLegacy.bookDir,
            resolveLibraryRoot(),
          );
        }

        /* Иt 8Е.1: cascade Chroma cleanup (hybrid стратегия).
           Этап 1 (sync, быстро): удалить точки книги из активной коллекции
           если она передана из renderer. Это покрывает 90% случаев —
           пользователь обычно работает с одной коллекцией.
           Этап 2 (async fire-and-forget): сканировать все коллекции и
           удалить orphan points в фоне. UI не ждёт.
           Оба этапа используют bookId фильтр (Иt 8Г.3 payload + индекс).
           bookSourcePath fallback не нужен — bookId стабильнее (выживает
           перемещение файла). */
        let chromaCleaned = 0;
        let chromaBackgroundScheduled = false;
        try {
          const { chromaDeleteByWhere } = await import("../lib/chroma/points.js");
          if (args.activeCollection) {
            const r = await chromaDeleteByWhere(args.activeCollection, { bookId: args.bookId });
            chromaCleaned = r.deleted;
          }
          /* Background full scan для orphan-vector cleanup во всех остальных коллекциях. */
          void (async () => {
            try {
              const { chromaUrl, fetchChromaJson } = await import("../lib/chroma/http-client.js");
              const collections = await fetchChromaJson<Array<{ name: string }>>(chromaUrl("/collections"));
              const names = (collections ?? []).map((c) => c.name);
              for (const collection of names) {
                if (collection === args.activeCollection) continue;
                try {
                  await chromaDeleteByWhere(collection, { bookId: args.bookId });
                } catch (innerErr) {
                  console.warn(`[library:delete-book] background cleanup failed for "${collection}":`, innerErr);
                }
              }
            } catch (bgErr) {
              console.warn("[library:delete-book] background full-scan failed:", bgErr);
            }
          })();
          chromaBackgroundScheduled = true;
        } catch (chromaErr) {
          /* Chroma unreachable — не блокируем delete-book (книга и так удалена
             из SQLite). Просто warning. */
          console.warn("[library:delete-book] Chroma cascade cleanup failed (non-fatal):", chromaErr);
        }

        return { ok: true, chromaCleaned, chromaBackgroundScheduled, filesRemoved, dirsRemoved };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e), filesRemoved, dirsRemoved };
      }
    }
  );

  /**
   * v1.0.2: Ручной запуск sweep'а битых импортов из UI.
   *
   * Сканирует unsupported-книги, проверяет original через file-validity
   * (multi-sample byte check), удаляет те где original = incomplete-torrent
   * или sparse-allocated. Возвращает summary {scanned, purged, missing,
   * skipped, freedBytes}. Idempotent.
   */
  ipcMain.handle(
    "library:purge-dead-imports",
    async (): Promise<{
      ok: boolean;
      reason?: string;
      scanned?: number;
      purged?: number;
      skipped?: number;
      missing?: number;
      freedBytes?: number;
      purgedDetails?: Array<{ id: string; title: string; reason: string; bytes: number }>;
    }> => {
      try {
        const { purgeDeadImports } = await import("../lib/library/dead-import-purger.js");
        const result = await purgeDeadImports({});
        return { ok: true, ...result };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  /**
   * Iter 13.2 (P6): "Сжечь библиотеку" — total reset для dev-режима.
   *
   * Удаляет:
   *   - все .md / .original.* / .meta.json / .illustrations.json под libraryRoot
   *   - .blobs/ (CAS-storage иллюстраций)
   *   - .import/ (state-журналы импорта, locks)
   *   - bibliary-cache.db (+ -wal, -shm) — закрываем хэндл ДО rm
   *   - все Chroma коллекции с префиксом "bibliary-" (best-effort, non-fatal)
   *
   * Сбрасывает all in-process кэши: near-dup, revision-dedup. Cache-DB
   * откроется заново лениво при следующем запросе (свежая, пустая).
   *
   * Зачем: пользователь после "удалить всё" в UI обнаруживал что файлы
   * остались на диске (delete-book удаляет только sidecars книги, но не
   * .blobs/.import; bookDir-cleanup best-effort через rmdir, не recursive).
   * Burn-all даёт чистый старт для тестирования импорта.
   */
  ipcMain.handle(
    "library:burn-all",
    async (): Promise<{
      ok: boolean;
      reason?: string;
      libraryRoot: string;
      removedFiles: number;
      removedDirs: number;
      chromaCleaned: number;
      chromaErrors: string[];
    }> => {
      const root = resolveLibraryRoot();
      const dbPath = getCacheDbPath();
      let removedFiles = 0;
      let removedDirs = 0;
      try {
        closeCacheDb();
        try {
          const stats = await fs.stat(root).catch(() => null);
          if (stats && stats.isDirectory()) {
            const counted = await countTreeEntries(root);
            removedFiles = counted.files;
            removedDirs = counted.dirs;
            await fs.rm(root, { recursive: true, force: true });
            await fs.mkdir(root, { recursive: true });
          }
        } catch (err) {
          console.warn("[library:burn-all] library root rm failed:", err);
        }
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          await fs.rm(`${dbPath}${suffix}`, { force: true }).catch(() => undefined);
        }
        resetNearDupCache();
        resetRevisionDedupCache();

        let chromaCleaned = 0;
        const chromaErrors: string[] = [];
        try {
          const { chromaUrl, fetchChromaJson } = await import("../lib/chroma/http-client.js");
          const { invalidate, clearAll } = await import("../lib/chroma/collection-cache.js");
          const collections = await fetchChromaJson<Array<{ name: string }>>(chromaUrl("/collections"));
          const names = (collections ?? [])
            .map((c) => c.name)
            .filter((n) => typeof n === "string" && n.startsWith("bibliary-"));
          for (const collection of names) {
            try {
              await fetchChromaJson(chromaUrl(`/collections/${encodeURIComponent(collection)}`), {
                method: "DELETE",
              });
              invalidate(collection);
              chromaCleaned += 1;
            } catch (err) {
              chromaErrors.push(`${collection}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          clearAll();
        } catch (chromaErr) {
          chromaErrors.push(chromaErr instanceof Error ? chromaErr.message : String(chromaErr));
        }

        return {
          ok: true,
          libraryRoot: root,
          removedFiles,
          removedDirs,
          chromaCleaned,
          chromaErrors,
        };
      } catch (e) {
        return {
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
          libraryRoot: root,
          removedFiles,
          removedDirs,
          chromaCleaned: 0,
          chromaErrors: [],
        };
      }
    }
  );

  ipcMain.handle(
    "library:rebuild-cache",
    async (): Promise<{ scanned: number; ingested: number; skipped: number; pruned: number; errors: string[] }> => {
      if (!resolveLibraryRoot()) {
        return { scanned: 0, ingested: 0, skipped: 0, pruned: 0, errors: ["library root not configured — set it in Settings first"] };
      }
      const rebuilt = await rebuildFromFs();
      const pruned = await pruneMissing();
      /* После массовых mutations (rebuild + prune) singleton near-dup кэш
         гарантированно stale — сбрасываем, перезагрузится лениво при первом
         запросе из свежей SQLite. */
      resetNearDupCache();
      resetRevisionDedupCache();
      return { ...rebuilt, pruned };
    }
  );
}
