import { Query } from "node-appwrite";

import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";

/**
 * Phase 11b — per-user storage usage aggregator. Walks every book a
 * user owns, sums file sizes across the three book buckets, then adds
 * dataset-export sizes from dataset_jobs. Best-effort:
 *
 *   - Missing files (deleted out of band) are skipped silently.
 *   - The full walk is bounded by USER_BUDGET_MS; anything past the
 *     budget is reported as `partial: true` so the UI can show a
 *     "still computing" badge instead of a zero.
 *
 * Why not cache? Single-pod, low-frequency surface (admin panel). Cache
 * is premature complexity until it actually hurts.
 */

type BookRefRow = RawDoc & {
  markdownFileId?: string;
  originalFileId?: string;
  coverFileId?: string;
};

type JobExportRow = RawDoc & {
  exportFileId?: string;
};

const USER_BUDGET_MS = 8_000;
const BOOKS_PAGE = 50;

export interface UserStorageUsage {
  userId: string;
  bookCount: number;
  bytesOriginal: number;
  bytesMarkdown: number;
  bytesCovers: number;
  bytesDatasets: number;
  totalBytes: number;
  partial: boolean;
}

async function sizeOf(bucketId: string, fileId: string | undefined): Promise<number> {
  if (!fileId) return 0;
  const { storage } = getAppwrite();
  try {
    const file = await storage.getFile(bucketId, fileId);
    return Number(file.sizeOriginal ?? 0);
  } catch (err) {
    if (isAppwriteCode(err, 404)) return 0;
    /* Other errors (network, perms) — swallow to keep the walk going.
     * Admin UI will see partial=true if many files fail. */
    return 0;
  }
}

export async function computeUserStorageUsage(userId: string): Promise<UserStorageUsage> {
  const deadline = Date.now() + USER_BUDGET_MS;
  const { databases, databaseId } = getAppwrite();

  let bookCount = 0;
  let bytesOriginal = 0;
  let bytesMarkdown = 0;
  let bytesCovers = 0;
  let bytesDatasets = 0;
  let partial = false;

  /* Books pass. */
  let offset = 0;
  while (true) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const page = await databases.listDocuments<BookRefRow>(databaseId, COLLECTIONS.books, [
      Query.equal("userId", userId),
      Query.select(["$id", "markdownFileId", "originalFileId", "coverFileId"]),
      Query.limit(BOOKS_PAGE),
      Query.offset(offset),
    ]);
    bookCount += page.documents.length;
    for (const b of page.documents) {
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      const [mdSz, origSz, covSz] = await Promise.all([
        sizeOf(BUCKETS.bookMarkdowns, b.markdownFileId),
        sizeOf(BUCKETS.bookOriginals, b.originalFileId),
        sizeOf(BUCKETS.bookCovers, b.coverFileId),
      ]);
      bytesMarkdown += mdSz;
      bytesOriginal += origSz;
      bytesCovers += covSz;
    }
    if (page.documents.length < BOOKS_PAGE) break;
    offset += BOOKS_PAGE;
  }

  /* Dataset exports pass — only if we still have budget. */
  if (!partial) {
    let dsOffset = 0;
    while (true) {
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      const page = await databases.listDocuments<JobExportRow>(databaseId, COLLECTIONS.datasetJobs, [
        Query.equal("userId", userId),
        Query.select(["$id", "exportFileId"]),
        Query.limit(BOOKS_PAGE),
        Query.offset(dsOffset),
      ]);
      for (const j of page.documents) {
        if (!j.exportFileId) continue;
        if (Date.now() > deadline) {
          partial = true;
          break;
        }
        bytesDatasets += await sizeOf(BUCKETS.datasetExports, j.exportFileId);
      }
      if (page.documents.length < BOOKS_PAGE) break;
      dsOffset += BOOKS_PAGE;
    }
  }

  const totalBytes = bytesOriginal + bytesMarkdown + bytesCovers + bytesDatasets;
  return {
    userId,
    bookCount,
    bytesOriginal,
    bytesMarkdown,
    bytesCovers,
    bytesDatasets,
    totalBytes,
    partial,
  };
}
