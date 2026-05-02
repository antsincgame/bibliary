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

import { ipcMain } from "electron";
import { promises as fs } from "fs";
import {
  query as queryCache,
  getBookById,
  deleteBook as dbDeleteBook,
  rebuildFromFs,
  pruneMissing,
  getCacheDbPath,
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
import { resolveCatalogSidecarPaths } from "../lib/library/storage-contract.js";
import { unregisterFromNearDup, resetNearDupCache } from "../lib/library/near-dup-detector.js";
import { resetRevisionDedupCache } from "../lib/library/revision-dedup.js";
import type { BookCatalogMeta } from "../lib/library/types.js";

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

  ipcMain.handle(
    "library:delete-book",
    async (_e, args: {
      bookId: string;
      deleteFiles?: boolean;
      /** Иt 8Е.1 (hybrid cascade): активная коллекция в renderer (если выбрана).
       *  Sync-удаление точек этой книги ДО возврата (быстро, ~50ms). */
      activeCollection?: string;
    }): Promise<{ ok: boolean; reason?: string; qdrantCleaned?: number; qdrantBackgroundScheduled?: boolean }> => {
      if (!args || typeof args.bookId !== "string") return { ok: false, reason: "bookId required" };
      const meta = getBookById(args.bookId);
      if (!meta) return { ok: false, reason: "not-found" };
      try {
        dbDeleteBook(args.bookId);
        /* Снимаем книгу с near-dup tracker'а, иначе следующий импорт
           похожей книги получит ложное предупреждение «near-duplicate of
           {удалённый-id}». Идемпотентно. */
        unregisterFromNearDup(meta);
        resetRevisionDedupCache();
        if (args.deleteFiles !== false) {
          /* Удаляем только файлы конкретной книги. Новый layout хранит много книг
             в data/library/<language>/<domain>/<author>/, поэтому удалять dirname(mdPath)
             целиком опасно: это может снести все книги автора. */
          const sidecars = await resolveCatalogSidecarPaths(meta);
          const toDelete = new Set([
            meta.mdPath,
            sidecars.originalPath,
            sidecars.metaPath,
            sidecars.illustrationsPath,
          ]);
          for (const p of toDelete) await fs.rm(p, { force: true });
          /* Best-effort cleanup empty legacy book dir / author dir. Если там
             остались другие книги, rmdir просто бросит ENOTEMPTY и мы игнорируем. */
          await fs.rmdir(sidecars.bookDir).catch(() => undefined);
        }

        /* Иt 8Е.1: cascade Qdrant cleanup (hybrid стратегия).
           Этап 1 (sync, быстро): удалить точки книги из активной коллекции
           если она передана из renderer. Это покрывает 90% случаев —
           пользователь обычно работает с одной коллекцией.
           Этап 2 (async fire-and-forget): сканировать все коллекции и
           удалить orphan points в фоне. UI не ждёт.
           Оба этапа используют bookId фильтр (Иt 8Г.3 payload + индекс).
           bookSourcePath fallback не нужен — bookId стабильнее (выживает
           перемещение файла). */
        let qdrantCleaned = 0;
        let qdrantBackgroundScheduled = false;
        try {
          const { deletePointsByFilter } = await import("../lib/qdrant/http-client.js");
          if (args.activeCollection) {
            const r = await deletePointsByFilter(args.activeCollection, [
              { field: "bookId", value: args.bookId },
            ]);
            qdrantCleaned = r.status === "ok" ? 1 : 0;
          }
          /* Background full scan для orphan-vector cleanup. */
          void (async () => {
            try {
              const { fetchQdrantJson, QDRANT_URL } = await import("../lib/qdrant/http-client.js");
              const all = await fetchQdrantJson<{ result?: { collections?: Array<{ name: string }> } }>(
                `${QDRANT_URL}/collections`,
              );
              const names = (all.result?.collections ?? []).map((c) => c.name);
              for (const collection of names) {
                if (collection === args.activeCollection) continue;
                try {
                  await deletePointsByFilter(collection, [{ field: "bookId", value: args.bookId }]);
                } catch (innerErr) {
                  console.warn(`[library:delete-book] background cleanup failed for "${collection}":`, innerErr);
                }
              }
            } catch (bgErr) {
              console.warn("[library:delete-book] background full-scan failed:", bgErr);
            }
          })();
          qdrantBackgroundScheduled = true;
        } catch (qdrantErr) {
          /* Qdrant unreachable — не блокируем delete-book (книга и так удалена
             из SQLite). Просто warning. */
          console.warn("[library:delete-book] Qdrant cascade cleanup failed (non-fatal):", qdrantErr);
        }

        return { ok: true, qdrantCleaned, qdrantBackgroundScheduled };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
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
