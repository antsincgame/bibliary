import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import Database, { type Database as DbType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { type Config, loadConfig } from "../../config.js";

let cached: { db: DbType; path: string; dim: number } | null = null;

function resolveVectorDbPath(cfg: Config): string {
  if (cfg.BIBLIARY_VECTORS_DB_PATH) {
    return resolve(cfg.BIBLIARY_VECTORS_DB_PATH);
  }
  return resolve(cfg.BIBLIARY_DATA_DIR, "vectors.db");
}

export function getVectorDb(cfg: Config = loadConfig()): { db: DbType; dim: number; path: string } {
  if (cached) return cached;

  const path = resolveVectorDbPath(cfg);
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 30000");

  sqliteVec.load(db);

  const dim = cfg.BIBLIARY_EMBEDDING_DIM;
  initSchema(db, dim);

  cached = { db, path, dim };
  return cached;
}

export function closeVectorDb(): void {
  if (cached) {
    try {
      cached.db.close();
    } catch {
      /* swallow — process is likely exiting */
    }
    cached = null;
  }
}

export function resetVectorDbForTesting(): void {
  closeVectorDb();
}

/**
 * Two vec0 virtual tables: chunks for raw book text embeddings, concepts
 * for crystallized concepts (collection-name partitioned). Both are
 * user-partitioned via auxiliary `user_id` column.
 */
function initSchema(db: DbType, dim: number): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      embedding float[${dim}],
      +user_id TEXT,
      +book_id TEXT,
      +chunk_index INTEGER
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS concepts_vec USING vec0(
      embedding float[${dim}],
      +user_id TEXT,
      +book_id TEXT,
      +collection_name TEXT
    );
  `);
}

/**
 * Health probe — runs a no-op query. Returns latency in ms; throws if
 * the file is unreadable or sqlite-vec failed to load.
 */
export function probeVectorDb(): { ok: true; latencyMs: number; path: string; dim: number } {
  const handle = getVectorDb();
  const t0 = Date.now();
  handle.db.prepare("SELECT vec_version() AS v").get();
  return { ok: true, latencyMs: Date.now() - t0, path: handle.path, dim: handle.dim };
}

/**
 * Used by Storage path during shutdown.
 */
export function getVectorDbPath(cfg: Config = loadConfig()): string {
  return resolveVectorDbPath(cfg);
}

/* Hint for grep: vector tables live next to this file's import sites. */
export const TABLE_CHUNKS = "chunks_vec";
export const TABLE_CONCEPTS = "concepts_vec";

export function dataPaths(cfg: Config = loadConfig()): { vectorsDb: string; dataDir: string } {
  return {
    vectorsDb: resolveVectorDbPath(cfg),
    dataDir: resolve(cfg.BIBLIARY_DATA_DIR),
  };
}

/* Exported for migration scripts that want to relocate the data dir. */
export function joinDataDir(...parts: string[]): string {
  const cfg = loadConfig();
  return join(resolve(cfg.BIBLIARY_DATA_DIR), ...parts);
}
