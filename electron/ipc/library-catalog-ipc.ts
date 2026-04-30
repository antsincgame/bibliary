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
    async (_e, args: { bookId: string; deleteFiles?: boolean }): Promise<{ ok: boolean; reason?: string }> => {
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
        return { ok: true };
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
