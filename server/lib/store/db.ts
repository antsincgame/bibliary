import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database, { type Database as DbType } from "better-sqlite3";

import { type Config, loadConfig } from "../../config.js";
import { bootstrapStoreSchema } from "./schema-bootstrap.js";

/**
 * Solo-mode document store connection.
 *
 * Separate SQLite file from the vector store (`vectors.db`): the vector
 * DB has its own lifecycle (sqlite-vec extension load, dim-drift guard,
 * WAL checkpoint on shutdown) and mixing the document tables in would
 * couple two concerns that change for different reasons. Two
 * better-sqlite3 handles to two files is cheap and keeps each module
 * single-purpose.
 *
 * This file holds the relational mirror of the Appwrite collections —
 * one table per `COLLECTION_SPECS` entry plus a `_solo_files` table for
 * the storage shim's file metadata. Schema is created idempotently by
 * `bootstrapStoreSchema` on first open.
 */

let cached: { db: DbType; path: string } | null = null;

function resolveSoloDbPath(cfg: Config): string {
  /* BIBLIARY_DB_PATH override exists mainly for tests, which point
   * it at a temp file (or :memory:) so each run starts clean. */
  if (cfg.BIBLIARY_DB_PATH) {
    return cfg.BIBLIARY_DB_PATH === ":memory:"
      ? ":memory:"
      : resolve(cfg.BIBLIARY_DB_PATH);
  }
  return resolve(cfg.BIBLIARY_DATA_DIR, "bibliary.db");
}

export function getStoreDb(cfg: Config = loadConfig()): { db: DbType; path: string } {
  if (cached) return cached;

  const path = resolveSoloDbPath(cfg);
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 30000");
  /* Appwrite enforces referential-ish integrity at the app layer; we
   * keep foreign_keys off and rely on the same app-layer checks so the
   * shim behaves identically to the Appwrite path. */

  bootstrapStoreSchema(db);

  cached = { db, path };
  return cached;
}

export function closeStoreDb(): void {
  if (cached) {
    try {
      cached.db.close();
    } catch {
      /* swallow — process is likely exiting */
    }
    cached = null;
  }
}

/** Test helper — drop the cached connection so the next getStoreDb() reopens. */
export function resetStoreDbForTesting(): void {
  closeStoreDb();
}
