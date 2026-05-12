import { getVectorDb, TABLE_CONCEPTS } from "./db.js";

/**
 * Phase 10b — sqlite-vec помещение DeltaKnowledge embeddings.
 *
 * Schema (см. db.ts initSchema): concepts_vec USING vec0(
 *   user_id TEXT PARTITION KEY,
 *   collection_name TEXT PARTITION KEY,
 *   embedding float[dim],
 *   +book_id TEXT  (auxiliary, returned via SELECT, not filterable in KNN)
 * )
 *
 * rowid в vec0 — auto-increment. Возвращаем rowid через lastInsertRowid
 * чтобы upstream concept document мог сохранить vectorRowId для
 * back-reference (Appwrite concepts.vectorRowId field).
 */

export interface VecInsertInput {
  userId: string;
  bookId: string;
  collectionName: string;
  embedding: Float32Array;
}

export function insertConceptVector(input: VecInsertInput): number {
  const { db } = getVectorDb();
  /* sqlite-vec ожидает embedding как JSON array ИЛИ Buffer of float32.
   * Buffer быстрее (no JSON encode/decode), но better-sqlite3 binds
   * Buffer корректно. Column order matches PARTITION KEY first → embedding → aux. */
  const buf = Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength);
  const result = db
    .prepare(
      `INSERT INTO ${TABLE_CONCEPTS} (user_id, collection_name, embedding, book_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.userId, input.collectionName, buf, input.bookId);
  return Number(result.lastInsertRowid);
}

export interface SimilarConceptRow {
  rowid: number;
  bookId: string;
  distance: number;
  /** Cosine similarity = 1 - distance (для normalized vectors). */
  similarity: number;
}

/**
 * Find top-K nearest concepts в same user + collection partition.
 * Используется для:
 *   - cross-collection dedup в extractor (Phase 10c): если новый delta
 *     similarity > 0.9 → skip
 *   - semantic search endpoint (Phase 10d): query embedding → top-N
 */
export function findSimilarConcepts(input: {
  userId: string;
  collectionName: string;
  embedding: Float32Array;
  limit?: number;
  /** Только rowid'ы выше этого similarity threshold. Default 0 (все top-K). */
  minSimilarity?: number;
}): SimilarConceptRow[] {
  const { db } = getVectorDb();
  const limit = Math.max(1, Math.min(100, input.limit ?? 10));
  const buf = Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength);
  /* sqlite-vec MATCH syntax: embedding MATCH ? → KNN search.
   * distance column авто-генерирован. Filter по partition keys в WHERE. */
  /* sqlite-vec KNN: PARTITION KEY WHERE-filters БЕФОР KNN; recommended
   * `AND k = ?` форма (TELL vec0 exact target — better чем post-LIMIT).
   * Auxiliary columns (`+book_id`) только в SELECT, не WHERE. */
  const rows = db
    .prepare(
      `SELECT rowid, book_id AS bookId, distance
       FROM ${TABLE_CONCEPTS}
       WHERE embedding MATCH ?
         AND user_id = ?
         AND collection_name = ?
         AND k = ?`,
    )
    .all(buf, input.userId, input.collectionName, limit) as Array<{
    rowid: number;
    bookId: string;
    distance: number;
  }>;

  const minSim = input.minSimilarity ?? 0;
  return rows
    .map((r) => ({
      rowid: r.rowid,
      bookId: r.bookId,
      distance: r.distance,
      similarity: 1 - r.distance, // cosine assuming normalized vectors
    }))
    .filter((r) => r.similarity >= minSim);
}

export function deleteConceptVector(rowid: number): boolean {
  const { db } = getVectorDb();
  const result = db.prepare(`DELETE FROM ${TABLE_CONCEPTS} WHERE rowid = ?`).run(rowid);
  return Number(result.changes) > 0;
}

/**
 * Bulk delete by user — used от burn-all flow. Возвращает count удалённых.
 */
export function deleteAllUserConceptVectors(userId: string): number {
  const { db } = getVectorDb();
  const result = db
    .prepare(`DELETE FROM ${TABLE_CONCEPTS} WHERE user_id = ?`)
    .run(userId);
  return Number(result.changes);
}
