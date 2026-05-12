import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { ID, Permission, Query, Role } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";
import { publishUser } from "../realtime/event-bus.js";
import { parseBook } from "../scanner/parsers-bridge.js";
import {
  detectExt,
  isSupportedBook,
  type SupportedExt,
} from "../scanner/parser-types.js";
import {
  buildBookMarkdown,
  estimateWordCount,
} from "./markdown.js";
import { createBook } from "./repository.js";

export type IngestJobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ImportFileResult {
  fileId: string;
  ingestJobId: string;
  status: "imported" | "duplicate" | "failed" | "unsupported";
  bookId?: string;
  sha256?: string;
  error?: string;
}

export interface ImportFilesResult {
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  unsupportedCount: number;
  results: ImportFileResult[];
}

/**
 * Sequentially process Appwrite-stored uploads into Bibliary books.
 *
 * Per file:
 *   1. Download from `book-originals` bucket → temp file
 *   2. SHA256 (whole file) → dedup probe against books{userId, sha256}
 *   3. parseBook (no OCR / no LLM — fast path)
 *   4. sections → markdown → upload to `book-markdowns` bucket
 *   5. Create books document with status="imported"
 *   6. Mark ingest_jobs document `done`
 *   7. Clean up temp file
 *
 * Errors per file are captured in ingest_jobs (state=failed, error message)
 * and do not abort the batch. The function returns aggregate counts.
 *
 * NOTE on bandwidth: legacy renderer uploaded files via IPC and Electron
 * read them from disk. In web mode the renderer uploads directly to
 * Appwrite Storage; the backend re-downloads them here. This double-trip
 * is the cost of stateless backend pods (no shared FS) — acceptable for
 * v1.0; Phase 7 introduces a worker that runs co-located with Appwrite.
 */
export async function importFiles(
  userId: string,
  fileIds: string[],
  options: { signal?: AbortSignal } = {},
): Promise<ImportFilesResult> {
  const results: ImportFileResult[] = [];
  let imported = 0;
  let duplicates = 0;
  let failed = 0;
  let unsupported = 0;

  for (const fileId of fileIds) {
    if (options.signal?.aborted) break;
    const ingestJobId = await createIngestJob(userId, fileId);
    let outcome: ImportFileResult;
    try {
      outcome = await importOne(userId, fileId, ingestJobId, options.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markIngestFailed(ingestJobId, msg);
      outcome = { fileId, ingestJobId, status: "failed", error: msg };
    }
    results.push(outcome);
    switch (outcome.status) {
      case "imported":
        imported += 1;
        break;
      case "duplicate":
        duplicates += 1;
        break;
      case "unsupported":
        unsupported += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
  }

  return {
    importedCount: imported,
    duplicateCount: duplicates,
    failedCount: failed,
    unsupportedCount: unsupported,
    results,
  };
}

async function importOne(
  userId: string,
  fileId: string,
  ingestJobId: string,
  signal: AbortSignal | undefined,
): Promise<ImportFileResult> {
  const { storage } = getAppwrite();
  await updateIngestJob(ingestJobId, { stage: "fetch", progress: 0.05 });

  const meta = await storage.getFile(BUCKETS.bookOriginals, fileId);
  const originalName = meta.name || `${fileId}.bin`;
  const ext = detectExt(originalName) as SupportedExt | null;

  if (!ext || !isSupportedBook(originalName)) {
    await markIngestFailed(ingestJobId, `unsupported_format: ${extname(originalName) || "<none>"}`);
    return { fileId, ingestJobId, status: "unsupported" };
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "bibliary-import-"));
  const tmpPath = join(tmpDir, originalName);
  try {
    const bytes = await downloadToBuffer(BUCKETS.bookOriginals, fileId);
    await writeFile(tmpPath, bytes);

    const sha256 = sha256Hex(bytes);
    await updateIngestJob(ingestJobId, { stage: "dedup", progress: 0.2 });

    const duplicate = await findDuplicate(userId, sha256);
    if (duplicate) {
      await updateIngestJob(ingestJobId, {
        state: "done",
        stage: "duplicate",
        progress: 1,
        message: `existing book ${duplicate}`,
      });
      return { fileId, ingestJobId, status: "duplicate", bookId: duplicate, sha256 };
    }

    await updateIngestJob(ingestJobId, { stage: "parse", progress: 0.35 });
    if (signal?.aborted) throw new Error("aborted");
    const parsed = await parseBook(tmpPath, signal ? { signal } : {});

    await updateIngestJob(ingestJobId, { stage: "markdown", progress: 0.7 });
    const markdown = buildBookMarkdown({
      metadata: parsed.metadata,
      sections: parsed.sections,
      originalFile: originalName,
      sha256,
    });
    const markdownFileId = await uploadMarkdown(userId, originalName, markdown);

    await updateIngestJob(ingestJobId, { stage: "create-book", progress: 0.9 });
    const book = await createBook({
      userId,
      title: parsed.metadata.title || originalName,
      sha256,
      ...(parsed.metadata.author ? { author: parsed.metadata.author } : {}),
      ...(parsed.metadata.language ? { language: parsed.metadata.language } : {}),
      ...(parsed.metadata.year !== undefined ? { year: parsed.metadata.year } : {}),
      wordCount: estimateWordCount(parsed.sections),
      markdownFileId,
      originalFileId: fileId,
      originalExtension: ext,
      status: "imported",
    });

    await updateIngestJob(ingestJobId, {
      state: "done",
      stage: "done",
      progress: 1,
      bookId: book.id,
    });

    return { fileId, ingestJobId, status: "imported", bookId: book.id, sha256 };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadToBuffer(bucketId: string, fileId: string): Promise<Uint8Array> {
  const { storage } = getAppwrite();
  const view = await storage.getFileDownload(bucketId, fileId);
  return view instanceof Uint8Array ? view : new Uint8Array(view as ArrayBuffer);
}

async function findDuplicate(userId: string, sha256: string): Promise<string | null> {
  const { databases, databaseId } = getAppwrite();
  const list = await databases.listDocuments<RawDoc>(databaseId, COLLECTIONS.books, [
    Query.equal("userId", userId),
    Query.equal("sha256", sha256),
    Query.select(["$id"]),
    Query.limit(1),
  ]);
  return list.documents[0]?.$id ?? null;
}

async function uploadMarkdown(
  userId: string,
  originalName: string,
  markdown: string,
): Promise<string> {
  const { storage } = getAppwrite();
  const fileId = ID.unique();
  const filename = `${originalName.replace(/\.[^.]+$/, "")}.md`;
  const input = InputFile.fromBuffer(Buffer.from(markdown, "utf-8"), filename);
  const file = await storage.createFile(BUCKETS.bookMarkdowns, fileId, input, [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
    Permission.read(Role.team("admin")),
  ]);
  return file.$id;
}

interface IngestPatch {
  state?: IngestJobState;
  stage?: string;
  progress?: number;
  message?: string;
  error?: string;
  bookId?: string;
}

async function createIngestJob(userId: string, originalFileId: string): Promise<string> {
  const { databases, databaseId } = getAppwrite();
  const nowIso = new Date().toISOString();
  const doc = await databases.createDocument(
    databaseId,
    COLLECTIONS.ingestJobs,
    ID.unique(),
    {
      userId,
      state: "running" as IngestJobState,
      stage: "queued",
      progress: 0,
      message: `import:${originalFileId}`,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    [
      Permission.read(Role.user(userId)),
      Permission.update(Role.user(userId)),
      Permission.delete(Role.user(userId)),
      Permission.read(Role.team("admin")),
    ],
  );
  return doc.$id;
}

async function updateIngestJob(jobId: string, patch: IngestPatch): Promise<void> {
  const { databases, databaseId } = getAppwrite();
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.state !== undefined) updates["state"] = patch.state;
  if (patch.stage !== undefined) updates["stage"] = patch.stage;
  if (patch.progress !== undefined) updates["progress"] = patch.progress;
  if (patch.message !== undefined) updates["message"] = patch.message;
  if (patch.error !== undefined) updates["error"] = patch.error;
  if (patch.bookId !== undefined) updates["bookId"] = patch.bookId;
  try {
    const updated = await databases.updateDocument<RawDoc & { userId: string }>(
      databaseId,
      COLLECTIONS.ingestJobs,
      jobId,
      updates,
    );
    /* Push событие подписчикам через SSE. Source-of-truth — Appwrite
     * document; bus всего лишь дёргает live UI. */
    publishUser(updated.userId, "ingest_jobs:update", {
      jobId,
      state: patch.state,
      stage: patch.stage,
      progress: patch.progress,
      message: patch.message,
      error: patch.error,
      bookId: patch.bookId,
    });
  } catch (err) {
    if (!isAppwriteCode(err, 404)) throw err;
  }
}

async function markIngestFailed(jobId: string, error: string): Promise<void> {
  await updateIngestJob(jobId, {
    state: "failed",
    stage: "failed",
    progress: 1,
    error: error.slice(0, 1800),
  });
}
