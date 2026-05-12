import { getVectorDb, TABLE_CHUNKS } from "./db.js";

/**
 * Phase Δb — chunks meta + vec0 storage. Each chunk lives in two
 * tables sharing one rowid:
 *
 *   chunks_vec  (vec0 virtual)  — embedding + user/book partition keys
 *   chunks      (relational)    — hierarchy metadata, FK by vec_rowid
 *
 * insertChunk atomically writes both inside an explicit transaction so
 * we never end up with a vector lacking metadata (orphan in KNN
 * results) or metadata lacking a vector (orphan in tree walks).
 *
 *   level 0 — proposition (Δe)
 *   level 1 — section chunk (this phase)
 *   level 2 — chapter summary (Δd)
 */

export interface ChunkInsertInput {
  userId: string;
  bookId: string;
  level: 0 | 1 | 2;
  embedding: Float32Array;
  text: string;
  pathTitles: string[];
  sectionLevel: number;
  sectionOrder: number;
  partN: number;
  partOf: number;
  parentVecRowId?: number | null;
  prevVecRowId?: number | null;
  nextVecRowId?: number | null;
}

export function insertChunk(input: ChunkInsertInput): number {
  const { db } = getVectorDb();
  const buf = Buffer.from(
    input.embedding.buffer,
    input.embedding.byteOffset,
    input.embedding.byteLength,
  );
  const tx = db.transaction((): number => {
    /* vec0 strictly checks aux column types — JS Number binds as REAL
     * by default in better-sqlite3, so cast to BigInt to force INTEGER. */
    const vecResult = db
      .prepare(
        `INSERT INTO ${TABLE_CHUNKS} (user_id, book_id, embedding, chunk_index)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.userId, input.bookId, buf, BigInt(Math.trunc(input.partN)));
    const rowid = Number(vecResult.lastInsertRowid);
    db.prepare(
      `INSERT INTO chunks (
         vec_rowid, user_id, book_id, level,
         section_order, section_level, path_titles,
         part_n, part_of, text,
         parent_vec_rowid, prev_vec_rowid, next_vec_rowid, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowid,
      input.userId,
      input.bookId,
      input.level,
      input.sectionOrder,
      input.sectionLevel,
      JSON.stringify(input.pathTitles),
      input.partN,
      input.partOf,
      input.text,
      input.parentVecRowId ?? null,
      input.prevVecRowId ?? null,
      input.nextVecRowId ?? null,
      new Date().toISOString(),
    );
    return rowid;
  });
  return tx();
}

/**
 * Sets prev/next pointers AFTER all chunks of a section have been
 * inserted (we don't know the next rowid at insert time). Two-pass
 * approach is cheaper than the bookkeeping required to link forward.
 */
export function linkChunkSiblings(rowIdsInOrder: number[]): void {
  if (rowIdsInOrder.length <= 1) return;
  const { db } = getVectorDb();
  const stmt = db.prepare(
    `UPDATE chunks SET prev_vec_rowid = ?, next_vec_rowid = ? WHERE vec_rowid = ?`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < rowIdsInOrder.length; i++) {
      const prev = i > 0 ? rowIdsInOrder[i - 1] : null;
      const next = i < rowIdsInOrder.length - 1 ? rowIdsInOrder[i + 1] : null;
      stmt.run(prev, next, rowIdsInOrder[i]);
    }
  });
  tx();
}

export interface ChunkRow {
  vecRowid: number;
  userId: string;
  bookId: string;
  level: number;
  sectionOrder: number | null;
  sectionLevel: number | null;
  pathTitles: string[];
  partN: number | null;
  partOf: number | null;
  text: string;
  parentVecRowId: number | null;
  prevVecRowId: number | null;
  nextVecRowId: number | null;
  createdAt: string;
}

function rowToChunk(r: Record<string, unknown>): ChunkRow {
  let path: string[] = [];
  if (typeof r["path_titles"] === "string") {
    try {
      const parsed = JSON.parse(r["path_titles"]);
      if (Array.isArray(parsed)) path = parsed.map(String);
    } catch {
      /* keep [] */
    }
  }
  return {
    vecRowid: Number(r["vec_rowid"]),
    userId: String(r["user_id"]),
    bookId: String(r["book_id"]),
    level: Number(r["level"]),
    sectionOrder: r["section_order"] == null ? null : Number(r["section_order"]),
    sectionLevel: r["section_level"] == null ? null : Number(r["section_level"]),
    pathTitles: path,
    partN: r["part_n"] == null ? null : Number(r["part_n"]),
    partOf: r["part_of"] == null ? null : Number(r["part_of"]),
    text: String(r["text"]),
    parentVecRowId:
      r["parent_vec_rowid"] == null ? null : Number(r["parent_vec_rowid"]),
    prevVecRowId: r["prev_vec_rowid"] == null ? null : Number(r["prev_vec_rowid"]),
    nextVecRowId: r["next_vec_rowid"] == null ? null : Number(r["next_vec_rowid"]),
    createdAt: String(r["created_at"]),
  };
}

export function getChunkByRowId(rowid: number): ChunkRow | null {
  const { db } = getVectorDb();
  const row = db.prepare(`SELECT * FROM chunks WHERE vec_rowid = ?`).get(rowid) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToChunk(row) : null;
}

export function getChunksByRowIds(rowIds: number[]): ChunkRow[] {
  if (rowIds.length === 0) return [];
  const { db } = getVectorDb();
  const placeholders = rowIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM chunks WHERE vec_rowid IN (${placeholders})`)
    .all(...rowIds) as Array<Record<string, unknown>>;
  return rows.map(rowToChunk);
}

export interface SimilarChunkRow {
  vecRowid: number;
  bookId: string;
  distance: number;
  similarity: number;
  level: number;
  pathTitles: string[];
  partN: number | null;
  partOf: number | null;
  text: string;
}

/**
 * KNN over user's chunks (any book). To restrict by book or level the
 * caller post-filters from chunks meta — vec0 only partitions by
 * user/book so cross-book search within one user is the natural use.
 */
export function findSimilarChunks(input: {
  userId: string;
  embedding: Float32Array;
  limit?: number;
  minSimilarity?: number;
  level?: 0 | 1 | 2;
  bookId?: string;
}): SimilarChunkRow[] {
  const { db } = getVectorDb();
  const limit = Math.max(1, Math.min(200, input.limit ?? 10));
  const buf = Buffer.from(
    input.embedding.buffer,
    input.embedding.byteOffset,
    input.embedding.byteLength,
  );
  const baseSql = input.bookId
    ? `SELECT rowid, distance
       FROM ${TABLE_CHUNKS}
       WHERE embedding MATCH ?
         AND user_id = ?
         AND book_id = ?
         AND k = ?`
    : `SELECT rowid, distance
       FROM ${TABLE_CHUNKS}
       WHERE embedding MATCH ?
         AND user_id = ?
         AND k = ?`;
  const knn = input.bookId
    ? (db.prepare(baseSql).all(buf, input.userId, input.bookId, limit) as Array<{
        rowid: number;
        distance: number;
      }>)
    : (db.prepare(baseSql).all(buf, input.userId, limit) as Array<{
        rowid: number;
        distance: number;
      }>);
  if (knn.length === 0) return [];
  const minSim = input.minSimilarity ?? 0;
  const metas = getChunksByRowIds(knn.map((r) => r.rowid));
  const byId = new Map(metas.map((m) => [m.vecRowid, m]));
  return knn
    .map((r) => {
      const m = byId.get(r.rowid);
      if (!m) return null;
      if (input.level !== undefined && m.level !== input.level) return null;
      const similarity = 1 - r.distance;
      if (similarity < minSim) return null;
      return {
        vecRowid: r.rowid,
        bookId: m.bookId,
        distance: r.distance,
        similarity,
        level: m.level,
        pathTitles: m.pathTitles,
        partN: m.partN,
        partOf: m.partOf,
        text: m.text,
      };
    })
    .filter((r): r is SimilarChunkRow => r !== null);
}

export function deleteAllChunksForBook(userId: string, bookId: string): number {
  const { db } = getVectorDb();
  /* Pull rowids first so vec0 delete can target them. There's no
   * cascade between vec0 and the relational chunks table. */
  const rows = db
    .prepare(`SELECT vec_rowid FROM chunks WHERE user_id = ? AND book_id = ?`)
    .all(userId, bookId) as Array<{ vec_rowid: number }>;
  if (rows.length === 0) return 0;
  const tx = db.transaction(() => {
    const vecStmt = db.prepare(`DELETE FROM ${TABLE_CHUNKS} WHERE rowid = ?`);
    const metaStmt = db.prepare(`DELETE FROM chunks WHERE vec_rowid = ?`);
    for (const { vec_rowid } of rows) {
      vecStmt.run(vec_rowid);
      metaStmt.run(vec_rowid);
    }
  });
  tx();
  return rows.length;
}

export function deleteAllChunksForUser(userId: string): number {
  const { db } = getVectorDb();
  const rows = db
    .prepare(`SELECT vec_rowid FROM chunks WHERE user_id = ?`)
    .all(userId) as Array<{ vec_rowid: number }>;
  if (rows.length === 0) return 0;
  const tx = db.transaction(() => {
    const vecStmt = db.prepare(`DELETE FROM ${TABLE_CHUNKS} WHERE rowid = ?`);
    const metaStmt = db.prepare(`DELETE FROM chunks WHERE vec_rowid = ?`);
    for (const { vec_rowid } of rows) {
      vecStmt.run(vec_rowid);
      metaStmt.run(vec_rowid);
    }
  });
  tx();
  return rows.length;
}

export function countChunksForBook(userId: string, bookId: string): number {
  const { db } = getVectorDb();
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE user_id = ? AND book_id = ?`)
    .get(userId, bookId) as { n: number };
  return Number(r.n);
}

/**
 * Phase Δd — set parent_vec_rowid on a batch of L1 (or L0) chunks to
 * point upward to the L2 summary that subsumes them. Used right after
 * an L2 summary row is inserted: pass the children's rowids + the new
 * parent's rowid.
 */
export function setParentForChunks(childRowIds: number[], parentRowId: number): void {
  if (childRowIds.length === 0) return;
  const { db } = getVectorDb();
  const stmt = db.prepare(`UPDATE chunks SET parent_vec_rowid = ? WHERE vec_rowid = ?`);
  const tx = db.transaction(() => {
    for (const id of childRowIds) stmt.run(parentRowId, id);
  });
  tx();
}

/**
 * Phase Δd — list L1 chunks under a given parent (or null parent) for
 * a (user, book). Used by the L2 summarizer to confirm coverage and
 * by Δf tree-proximity scoring.
 */
export function listL1ChunksForUnit(
  userId: string,
  bookId: string,
  sectionOrder: number,
): ChunkRow[] {
  const { db } = getVectorDb();
  const rows = db
    .prepare(
      `SELECT * FROM chunks
       WHERE user_id = ? AND book_id = ? AND level = 1 AND section_order = ?
       ORDER BY part_n ASC`,
    )
    .all(userId, bookId, sectionOrder) as Array<Record<string, unknown>>;
  return rows.map(rowToChunk);
}
