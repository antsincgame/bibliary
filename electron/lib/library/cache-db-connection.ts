/**
 * Singleton better-sqlite3 connection management.
 *
 * Единственный владелец DB-хэндла. Все остальные модули получают db через
 * openCacheDb() — никогда не создают Database напрямую.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import * as path from "path";
import { resolveLibraryRoot } from "./paths.js";
import { SCHEMA_SQL, applyMigrations } from "./cache-db-schema.js";

let cachedDb: Database.Database | null = null;
let cachedDbPath: string | null = null;

function resolveDbPath(): string {
  const fromEnv = process.env.BIBLIARY_LIBRARY_DB?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const dataDir = process.env.BIBLIARY_DATA_DIR?.trim();
  if (dataDir) return path.resolve(dataDir, "bibliary-cache.db");
  return path.resolve(path.dirname(resolveLibraryRoot()), "bibliary-cache.db");
}

export function openCacheDb(): Database.Database {
  const wantedPath = resolveDbPath();
  if (cachedDb && cachedDbPath === wantedPath) return cachedDb;
  if (cachedDb && cachedDbPath !== wantedPath) {
    cachedDb.close();
    cachedDb = null;
  }
  const dir = path.dirname(wantedPath);
  mkdirSync(dir, { recursive: true });
  const db = new Database(wantedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  cachedDb = db;
  cachedDbPath = wantedPath;
  return db;
}

export function closeCacheDb(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedDbPath = null;
  }
}

export function getCacheDbPath(): string {
  return cachedDbPath ?? resolveDbPath();
}
