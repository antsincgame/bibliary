/**
 * Per-user vector collection abstraction over sqlite-vec.
 *
 * "Collections" in the legacy IPC API map onto the `collection_name`
 * partition of `concepts_vec`. Users can have multiple named collections
 * (e.g. "default", "physics-2024") plus the implicit `chunks` table for
 * raw book-text embeddings (not collection-named).
 *
 * Phase 2c surface area is minimal: list/info/delete + heartbeat for the
 * /api/vectordb routes. Insert / query helpers will come with Phase 5
 * once we wire embedder workers.
 */

import { getVectorDb, probeVectorDb, TABLE_CONCEPTS, TABLE_CHUNKS } from "./db.js";

export interface CollectionInfo {
  name: string;
  pointsCount: number;
}

export interface VectorDbHeartbeat {
  online: boolean;
  url: string;
  version: string;
  collectionsCount: number;
  latencyMs?: number;
  message?: string;
}

export function listCollections(userId: string): CollectionInfo[] {
  const { db } = getVectorDb();
  const rows = db
    .prepare(
      `SELECT collection_name AS name, COUNT(*) AS count
       FROM ${TABLE_CONCEPTS}
       WHERE user_id = ?
       GROUP BY collection_name
       ORDER BY collection_name`,
    )
    .all(userId) as Array<{ name: string; count: number | bigint }>;
  return rows.map((r) => ({ name: r.name, pointsCount: Number(r.count) }));
}

export function getCollectionInfo(userId: string, name: string): CollectionInfo | null {
  const { db } = getVectorDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${TABLE_CONCEPTS}
       WHERE user_id = ? AND collection_name = ?`,
    )
    .get(userId, name) as { count: number | bigint } | undefined;
  if (!row || Number(row.count) === 0) return null;
  return { name, pointsCount: Number(row.count) };
}

export function deleteCollection(userId: string, name: string): { deleted: number } {
  const { db } = getVectorDb();
  const result = db
    .prepare(`DELETE FROM ${TABLE_CONCEPTS} WHERE user_id = ? AND collection_name = ?`)
    .run(userId, name);
  return { deleted: Number(result.changes) };
}

export function countChunks(userId: string): number {
  const { db } = getVectorDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${TABLE_CHUNKS} WHERE user_id = ?`)
    .get(userId) as { count: number | bigint } | undefined;
  return row ? Number(row.count) : 0;
}

export function heartbeat(userId: string): VectorDbHeartbeat {
  try {
    const probe = probeVectorDb();
    const collections = listCollections(userId);
    return {
      online: true,
      url: probe.path,
      version: "sqlite-vec",
      collectionsCount: collections.length,
      latencyMs: probe.latencyMs,
    };
  } catch (err) {
    return {
      online: false,
      url: "",
      version: "sqlite-vec",
      collectionsCount: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
