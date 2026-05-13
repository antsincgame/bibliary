import { getVectorDb } from "./db.js";

/**
 * Phase Δc — knowledge graph over the user's library.
 *
 * Three relational tables, all owned by the same sqlite-vec DB file so
 * graph rows live next to their source chunk vec_rowid without an
 * external join. Topology is layered ON TOP of the existing
 * DeltaKnowledge.relations array — we do not change the LLM contract;
 * we just persist (and canonicalize) what the crystallizer already
 * emits.
 *
 *   entities         — canonical nodes per user (unique (user_id, canonical))
 *   entity_aliases   — alternative spellings seen in source
 *   relations        — typed edges (S, predicate, O, source_chunk)
 *
 * Canonicalization is intentionally simple (lowercase + whitespace +
 * punctuation strip). LLM-based alias merge can be layered later
 * without touching the storage shape.
 */

const PUNCT_STRIP_RE = /[.,;:!?"'`«»“”‘’()]/g;
const WHITESPACE_RE = /\s+/g;

export function canonicalizeEntityName(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(PUNCT_STRIP_RE, "")
    .replace(WHITESPACE_RE, " ")
    .trim();
}

export interface EntityRow {
  id: number;
  userId: string;
  canonical: string;
  display: string;
  createdAt: string;
}

/**
 * Find-or-create. If the canonical form already exists for this user,
 * returns the existing entity and (optionally) records the new spelling
 * as an alias. Otherwise creates the entity with `display` set to the
 * caller-supplied spelling.
 *
 * Why store display separately? The first spelling we see becomes the
 * "representative" used in UIs; aliases stay queryable for fuzzy hits.
 */
export function upsertEntity(userId: string, name: string): EntityRow {
  const canonical = canonicalizeEntityName(name);
  if (canonical.length === 0) {
    throw new Error(`upsertEntity: empty canonical for input "${name}"`);
  }
  const { db } = getVectorDb();
  const nowIso = new Date().toISOString();
  const existing = db
    .prepare(`SELECT id, user_id, canonical, display, created_at FROM entities WHERE user_id = ? AND canonical = ?`)
    .get(userId, canonical) as
    | { id: number; user_id: string; canonical: string; display: string; created_at: string }
    | undefined;
  if (existing) {
    /* Record the spelling as an alias if it differs from the stored display. */
    const trimmed = name.trim();
    if (trimmed && trimmed !== existing.display) {
      try {
        const has = db
          .prepare(`SELECT 1 FROM entity_aliases WHERE entity_id = ? AND alias = ?`)
          .get(existing.id, trimmed);
        if (!has) {
          db.prepare(`INSERT INTO entity_aliases (entity_id, alias) VALUES (?, ?)`).run(
            existing.id,
            trimmed,
          );
        }
      } catch {
        /* Alias dedup not critical — swallow. */
      }
    }
    return {
      id: existing.id,
      userId: existing.user_id,
      canonical: existing.canonical,
      display: existing.display,
      createdAt: existing.created_at,
    };
  }
  const result = db
    .prepare(`INSERT INTO entities (user_id, canonical, display, created_at) VALUES (?, ?, ?, ?)`)
    .run(userId, canonical, name.trim(), nowIso);
  const id = Number(result.lastInsertRowid);
  return {
    id,
    userId,
    canonical,
    display: name.trim(),
    createdAt: nowIso,
  };
}

export interface RelationInsertInput {
  userId: string;
  bookId: string;
  subjectId: number;
  predicate: string;
  objectId: number;
  sourceChunkVecRowId?: number | null;
}

export interface RelationRow {
  id: number;
  userId: string;
  bookId: string;
  subjectId: number;
  predicate: string;
  objectId: number;
  sourceChunkVecRowId: number | null;
  createdAt: string;
}

export function insertRelation(input: RelationInsertInput): number {
  const { db } = getVectorDb();
  const nowIso = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO relations (user_id, book_id, subject_id, predicate, object_id, source_chunk_vec_rowid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.bookId,
      input.subjectId,
      input.predicate.trim(),
      input.objectId,
      input.sourceChunkVecRowId ?? null,
      nowIso,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Ingest a DeltaKnowledge.relations array in one transaction. Returns
 * the count of inserted edges (some may be skipped if subject/object
 * canonicalize to empty strings — rare, but possible if the LLM
 * emitted pure punctuation).
 */
export function ingestRelations(input: {
  userId: string;
  bookId: string;
  triples: ReadonlyArray<{ subject: string; predicate: string; object: string }>;
  sourceChunkVecRowId?: number | null;
}): { entitiesTouched: number; relationsInserted: number } {
  const { db } = getVectorDb();
  let entitiesTouched = 0;
  let relationsInserted = 0;
  const seen = new Set<number>();
  const tx = db.transaction(() => {
    for (const t of input.triples) {
      const subjCanon = canonicalizeEntityName(t.subject);
      const objCanon = canonicalizeEntityName(t.object);
      if (subjCanon.length === 0 || objCanon.length === 0) continue;
      const subj = upsertEntity(input.userId, t.subject);
      const obj = upsertEntity(input.userId, t.object);
      if (!seen.has(subj.id)) {
        seen.add(subj.id);
        entitiesTouched += 1;
      }
      if (!seen.has(obj.id)) {
        seen.add(obj.id);
        entitiesTouched += 1;
      }
      insertRelation({
        userId: input.userId,
        bookId: input.bookId,
        subjectId: subj.id,
        predicate: t.predicate,
        objectId: obj.id,
        sourceChunkVecRowId: input.sourceChunkVecRowId ?? null,
      });
      relationsInserted += 1;
    }
  });
  tx();
  return { entitiesTouched, relationsInserted };
}

/**
 * Snapshot of canonical names currently in scope for a book — used by
 * the running entity registry that the crystallizer sees on subsequent
 * units. Limits to MAX so the prompt budget doesn't blow up on
 * encyclopedia-size books.
 */
export function getEntitiesForBookRegistry(
  userId: string,
  bookId: string,
  max: number = 50,
): Array<{ display: string; canonical: string }> {
  const { db } = getVectorDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT e.display AS display, e.canonical AS canonical
       FROM entities e
       INNER JOIN relations r ON r.subject_id = e.id OR r.object_id = e.id
       WHERE e.user_id = ? AND r.book_id = ?
       ORDER BY e.id DESC
       LIMIT ?`,
    )
    .all(userId, bookId, max) as Array<{ display: string; canonical: string }>;
  return rows;
}

export function countEntitiesForUser(userId: string): number {
  const { db } = getVectorDb();
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM entities WHERE user_id = ?`)
    .get(userId) as { n: number };
  return Number(r.n);
}

export function countRelationsForBook(userId: string, bookId: string): number {
  const { db } = getVectorDb();
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM relations WHERE user_id = ? AND book_id = ?`)
    .get(userId, bookId) as { n: number };
  return Number(r.n);
}

/**
 * Used by burn-all + per-book re-extract. Deletes relations first
 * (FK), then any entities that no longer have any incident edge.
 * Entities created by another book stay alive.
 */
export function deleteGraphForBook(userId: string, bookId: string): {
  relationsDeleted: number;
  entitiesDeleted: number;
} {
  const { db } = getVectorDb();
  const tx = db.transaction((): { relationsDeleted: number; entitiesDeleted: number } => {
    const rel = db
      .prepare(`DELETE FROM relations WHERE user_id = ? AND book_id = ?`)
      .run(userId, bookId);
    /* Orphan sweep: any entity with no surviving relations is dropped. */
    const ent = db
      .prepare(
        `DELETE FROM entities WHERE user_id = ? AND id NOT IN (
           SELECT subject_id FROM relations WHERE user_id = ?
           UNION
           SELECT object_id FROM relations WHERE user_id = ?
         )`,
      )
      .run(userId, userId, userId);
    return {
      relationsDeleted: Number(rel.changes),
      entitiesDeleted: Number(ent.changes),
    };
  });
  return tx();
}

export function deleteGraphForUser(userId: string): {
  relationsDeleted: number;
  entitiesDeleted: number;
} {
  const { db } = getVectorDb();
  const tx = db.transaction((): { relationsDeleted: number; entitiesDeleted: number } => {
    const rel = db.prepare(`DELETE FROM relations WHERE user_id = ?`).run(userId);
    const ent = db.prepare(`DELETE FROM entities WHERE user_id = ?`).run(userId);
    return {
      relationsDeleted: Number(rel.changes),
      entitiesDeleted: Number(ent.changes),
    };
  });
  return tx();
}
