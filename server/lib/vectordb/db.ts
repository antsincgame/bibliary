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
 * Two vec0 virtual tables. PARTITION KEY allows WHERE filtering before
 * KNN search (auxiliary `+` columns не filterable в KNN per sqlite-vec
 * 0.1.6 docs — Phase 10 schema rev).
 *
 * NOTE: changing this schema with existing data requires DROP TABLE +
 * re-insert. Pre-production это OK; Phase 11+ deploy migration —
 * docs/deployment.md.
 */
function initSchema(db: DbType, dim: number): void {
  /* distance_metric=cosine — для normalized E5 embeddings cosine
   * distance корректно отражает semantic similarity. Default vec0
   * L2 даёт некалибрированный distance для unit vectors
   * (max=√2 ≈ 1.414, not 1.0). */
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      user_id TEXT PARTITION KEY,
      book_id TEXT PARTITION KEY,
      embedding float[${dim}] distance_metric=cosine,
      +chunk_index INTEGER
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS concepts_vec USING vec0(
      user_id TEXT PARTITION KEY,
      collection_name TEXT PARTITION KEY,
      embedding float[${dim}] distance_metric=cosine,
      +book_id TEXT
    );
  `);
  /* Phase Δb — relational chunks metadata. Lives in the SAME sqlite
   * file next to vec0 virtual tables so KNN rowid ↔ meta join is a
   * cheap PK lookup. We avoid graph edges in Appwrite (joins would
   * explode quota) and keep the topology core local. vec_rowid is the
   * chunks_vec rowid — owned by sqlite-vec auto-increment, never
   * minted manually.
   *
   *   level 0 — atomic proposition (Δe; lazy)
   *   level 1 — section chunk (Δb; primary retrieval unit)
   *   level 2 — chapter summary (Δd; RAPTOR bottom-up)
   *
   * parent_vec_rowid points to the L2 summary that subsumes an L1
   * chunk, or the L1 chunk a proposition came from. prev/next pointers
   * link siblings in document order within the same section — used
   * for narrative-flow tree-proximity scoring at retrieval (Δf). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      vec_rowid INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      section_order INTEGER,
      section_level INTEGER,
      path_titles TEXT,
      part_n INTEGER,
      part_of INTEGER,
      text TEXT NOT NULL,
      parent_vec_rowid INTEGER,
      prev_vec_rowid INTEGER,
      next_vec_rowid INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_user_book ON chunks(user_id, book_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_vec_rowid);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_level ON chunks(level);`);

  /* Phase Δc — knowledge graph. Entities are canonical nodes;
   * aliases capture alternative spellings observed in source; relations
   * are typed edges (S, predicate, O) that point back to the L1 chunk
   * that produced them so retrieval can score "narrative origin". */
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      canonical TEXT NOT NULL,
      display TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, canonical)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_aliases_alias ON entity_aliases(alias);`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      predicate TEXT NOT NULL,
      object_id INTEGER NOT NULL,
      source_chunk_vec_rowid INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (subject_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (object_id) REFERENCES entities(id) ON DELETE CASCADE
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(object_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_user_book ON relations(user_id, book_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_chunk_vec_rowid);`);
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
