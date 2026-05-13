import { Query } from "node-appwrite";

import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";
import { getVectorDb, TABLE_CHUNKS, TABLE_CONCEPTS } from "../vectordb/db.js";

export interface BurnAllResult {
  ok: boolean;
  booksDeleted: number;
  chunksDeleted: number;
  conceptsDeleted: number;
  storageFilesRemoved: number;
  storageFilesFailed: number;
  vectorRowsDeleted: number;
}

type BookFileRefs = RawDoc & {
  markdownFileId?: string;
  originalFileId?: string;
  coverFileId?: string;
};

const PAGE_SIZE = 100;

async function deleteAllInCollection(
  collectionId: string,
  userId: string,
): Promise<number> {
  const { databases, databaseId } = getAppwrite();
  let total = 0;
  while (true) {
    const page = await databases.listDocuments(databaseId, collectionId, [
      Query.equal("userId", userId),
      Query.limit(PAGE_SIZE),
    ]);
    if (page.documents.length === 0) break;
    for (const doc of page.documents) {
      try {
        await databases.deleteDocument(databaseId, collectionId, doc.$id);
        total += 1;
      } catch (err) {
        if (!isAppwriteCode(err, 404)) throw err;
      }
    }
    if (page.documents.length < PAGE_SIZE) break;
  }
  return total;
}

/**
 * Pages through user's books once to gather all Storage file IDs, then
 * deletes each Storage file before the parent document is wiped. We hit
 * the books collection BEFORE deleteAllInCollection(books) so the file
 * references aren't lost mid-burn.
 */
async function collectBookFileRefs(userId: string): Promise<{
  markdowns: string[];
  originals: string[];
  covers: string[];
}> {
  const { databases, databaseId } = getAppwrite();
  const out = { markdowns: [] as string[], originals: [] as string[], covers: [] as string[] };
  let offset = 0;
  while (true) {
    const page = await databases.listDocuments<BookFileRefs>(databaseId, COLLECTIONS.books, [
      Query.equal("userId", userId),
      Query.select(["$id", "markdownFileId", "originalFileId", "coverFileId"]),
      Query.limit(PAGE_SIZE),
      Query.offset(offset),
    ]);
    for (const doc of page.documents) {
      if (doc.markdownFileId) out.markdowns.push(doc.markdownFileId);
      if (doc.originalFileId) out.originals.push(doc.originalFileId);
      if (doc.coverFileId) out.covers.push(doc.coverFileId);
    }
    if (page.documents.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

async function deleteStorageFiles(
  bucketId: string,
  fileIds: string[],
): Promise<{ removed: number; failed: number }> {
  const { storage } = getAppwrite();
  let removed = 0;
  let failed = 0;
  for (const id of fileIds) {
    try {
      await storage.deleteFile(bucketId, id);
      removed += 1;
    } catch (err) {
      if (isAppwriteCode(err, 404)) {
        /* Already gone — count as removed for idempotent UX. */
        removed += 1;
      } else {
        failed += 1;
      }
    }
  }
  return { removed, failed };
}

function wipeVectorRows(userId: string): number {
  const { db } = getVectorDb();
  const chunks = db.prepare(`DELETE FROM ${TABLE_CHUNKS} WHERE user_id = ?`).run(userId);
  const concepts = db.prepare(`DELETE FROM ${TABLE_CONCEPTS} WHERE user_id = ?`).run(userId);
  return Number(chunks.changes) + Number(concepts.changes);
}

/**
 * Idempotent — running burn-all twice on the same user is a safe no-op the
 * second time. Order matters: collect file refs FIRST, then docs, then
 * vectors. We tolerate per-file 404s (file already gone) by counting as
 * successful removal.
 */
export async function burnAllForUser(userId: string): Promise<BurnAllResult> {
  const refs = await collectBookFileRefs(userId);

  const mdRemoval = await deleteStorageFiles(BUCKETS.bookMarkdowns, refs.markdowns);
  const origRemoval = await deleteStorageFiles(BUCKETS.bookOriginals, refs.originals);
  const coverRemoval = await deleteStorageFiles(BUCKETS.bookCovers, refs.covers);

  const chunksDeleted = await deleteAllInCollection(COLLECTIONS.bookChunks, userId);
  const conceptsDeleted = await deleteAllInCollection(COLLECTIONS.concepts, userId);
  const booksDeleted = await deleteAllInCollection(COLLECTIONS.books, userId);

  const vectorRowsDeleted = wipeVectorRows(userId);

  const storageFilesFailed =
    mdRemoval.failed + origRemoval.failed + coverRemoval.failed;
  /* Pre-release fix: don't return ok=true when storage deletions
   * partially failed. The caller (route + audit log) needs to know
   * the burn was incomplete so the user can retry; before this fix
   * the API surface lied about success when files were left behind. */
  return {
    ok: storageFilesFailed === 0,
    booksDeleted,
    chunksDeleted,
    conceptsDeleted,
    storageFilesRemoved: mdRemoval.removed + origRemoval.removed + coverRemoval.removed,
    storageFilesFailed,
    vectorRowsDeleted,
  };
}
