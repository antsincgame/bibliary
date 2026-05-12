import { ID, Permission, Role } from "node-appwrite";

import { COLLECTIONS, getAppwrite, isAppwriteCode } from "../appwrite.js";
import { buildConceptEmbedText, embedPassage } from "../embedder/index.js";
import {
  deleteConceptVector,
  findSimilarConcepts,
  insertConceptVector,
  type SimilarConceptRow,
} from "../vectordb/concepts.js";

import type { DeltaKnowledge } from "../../../shared/llm/extractor-schema.js";

/**
 * Concept persistence layer — Phase 10b/10c.
 *
 * Carved out of extractor-bridge.ts during the Round-3 god-object
 * split. Responsibility: take an accepted DeltaKnowledge, embed it,
 * deduplicate against existing concepts in the same user+collection
 * partition, then write to Appwrite concepts collection + sqlite-vec
 * concepts_vec atomically (best-effort — vec orphans are tolerated).
 *
 * Public surface: persistConcept(...).
 */

/** Phase 10c cross-collection semantic dedup threshold. */
export const DEDUP_SIMILARITY_THRESHOLD = 0.9;

const CONCEPT_PAYLOAD_MAX_CHARS = 19_000;

interface EmbedAndStoreResult {
  rowid: number;
  embedding: Float32Array;
}

/**
 * Embed a delta + INSERT into sqlite-vec. Returns rowid; null on
 * embedder failure (we still persist the concept doc, just without
 * vectorRowId — search/dedup features degrade for it).
 */
async function embedAndStore(
  userId: string,
  bookId: string,
  collectionName: string,
  delta: DeltaKnowledge,
): Promise<EmbedAndStoreResult | null> {
  try {
    const text = buildConceptEmbedText(delta);
    const embedding = await embedPassage(text);
    const rowid = insertConceptVector({
      userId,
      bookId,
      collectionName,
      embedding,
    });
    return { rowid, embedding };
  } catch (err) {
    console.warn(
      `[concept-persistence] embed failed for concept (${err instanceof Error ? err.message : err}); persisting без vectorRowId`,
    );
    return null;
  }
}

/**
 * Check if a concept with cosine >= DEDUP_SIMILARITY_THRESHOLD already
 * exists in the same partition. Returns the matching row (or null).
 * Failures are swallowed — dedup is an optimization, not a correctness
 * requirement, so we never block the extraction pipeline on it.
 */
function checkSemanticDuplicate(
  userId: string,
  collectionName: string,
  embedding: Float32Array,
): SimilarConceptRow | null {
  try {
    const similar = findSimilarConcepts({
      userId,
      collectionName,
      embedding,
      limit: 1,
      minSimilarity: DEDUP_SIMILARITY_THRESHOLD,
    });
    return similar[0] ?? null;
  } catch (err) {
    console.warn(
      `[concept-persistence] dedup search failed (${err instanceof Error ? err.message : err}); proceeding без dedup`,
    );
    return null;
  }
}

export interface PersistConceptResult {
  /** Concept document was created. */
  persisted: boolean;
  /** Concept was dropped because cosine ≥ DEDUP_SIMILARITY_THRESHOLD vs existing. */
  dedupSkipped: boolean;
}

/**
 * Persist an accepted DeltaKnowledge:
 *   1. Embed (concept-level text composition).
 *   2. Self-dedup against existing concepts in the partition; if a
 *      pre-existing concept has cosine ≥ threshold, rollback our just-
 *      inserted vector and return dedupSkipped=true.
 *   3. Create the Appwrite concepts document with vectorRowId
 *      back-reference (or null if embedder failed).
 *
 * Returns { persisted, dedupSkipped } so the caller can update
 * counters (accepted vs failed vs skipped).
 */
export async function persistConcept(
  userId: string,
  bookId: string,
  collectionName: string,
  delta: DeltaKnowledge,
): Promise<PersistConceptResult> {
  const embeddedResult = await embedAndStore(userId, bookId, collectionName, delta);

  /* If embedding succeeded, run dedup against the freshly inserted
   * vector. findSimilar will return our own row (distance 0) — skip
   * self-match by rowid. A real duplicate has a DIFFERENT rowid. */
  if (embeddedResult) {
    const similar = checkSemanticDuplicate(
      userId,
      collectionName,
      embeddedResult.embedding,
    );
    if (similar && similar.rowid !== embeddedResult.rowid) {
      try {
        deleteConceptVector(embeddedResult.rowid);
      } catch {
        /* swallow — orphan vector не критично */
      }
      return { persisted: false, dedupSkipped: true };
    }
  }

  const { databases, databaseId } = getAppwrite();
  const nowIso = new Date().toISOString();
  const payload = JSON.stringify(delta).slice(0, CONCEPT_PAYLOAD_MAX_CHARS);
  try {
    const doc: Record<string, unknown> = {
      userId,
      bookId,
      collectionName,
      payload,
      accepted: true,
      createdAt: nowIso,
    };
    if (embeddedResult) {
      doc["vectorRowId"] = embeddedResult.rowid;
    }
    await databases.createDocument(
      databaseId,
      COLLECTIONS.concepts,
      ID.unique(),
      doc,
      [
        Permission.read(Role.user(userId)),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
        Permission.read(Role.team("admin")),
      ],
    );
    return { persisted: true, dedupSkipped: false };
  } catch (err) {
    /* Duplicates by vectorRowId can happen on retry — ignore 409. */
    if (isAppwriteCode(err, 409)) {
      return { persisted: false, dedupSkipped: false };
    }
    throw err;
  }
}
