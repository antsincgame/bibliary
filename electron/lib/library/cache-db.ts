/**
 * Library Cache DB — barrel re-export.
 *
 * Source of truth: `data/library/{slug}/book.md` (YAML frontmatter + body).
 * This DB is rebuildable: delete `bibliary-cache.db`, restart, scan all .md
 * files via `rebuildFromFs()` -- and the catalog is back.
 *
 * Implementation split:
 *   cache-db-schema.ts     — DDL + migrations
 *   cache-db-connection.ts — singleton open/close
 *   cache-db-types.ts      — BookRow, rowToMeta, CatalogQuery, RevisionDedupBook
 *   cache-db-mutations.ts  — upsert, delete, setStatus
 *   cache-db-queries.ts    — query, getById, stream, dedup list
 *   cache-db-rebuild.ts    — rebuildFromFs, pruneMissing
 */

export { openCacheDb, closeCacheDb, getCacheDbPath } from "./cache-db-connection.js";
export type { CatalogQuery, RevisionDedupBook } from "./cache-db-types.js";
export { upsertBook, getKnownSha256s, deleteBook, setBookStatus } from "./cache-db-mutations.js";
export { query, getBookById, streamBookIdsByStatus, getBooksByIds, listBooksForRevisionDedup, queryTagStats } from "./cache-db-queries.js";
export { rebuildFromFs, pruneMissing } from "./cache-db-rebuild.js";
