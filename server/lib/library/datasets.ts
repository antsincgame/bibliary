import { Query } from "node-appwrite";

import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";

export type DatasetJobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface DatasetJobDoc {
  id: string;
  userId: string;
  batchId: string | null;
  state: DatasetJobState;
  stage: string | null;
  booksTotal: number;
  booksProcessed: number;
  conceptsExtracted: number;
  targetCollection: string | null;
  extractModel: string | null;
  exportFileId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type RawDatasetJob = RawDoc & {
  userId: string;
  batchId?: string;
  state: DatasetJobState;
  stage?: string;
  booksTotal?: number;
  booksProcessed?: number;
  conceptsExtracted?: number;
  targetCollection?: string;
  extractModel?: string;
  exportFileId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function toJob(raw: RawDatasetJob): DatasetJobDoc {
  return {
    id: raw.$id,
    userId: raw.userId,
    batchId: raw.batchId ?? null,
    state: raw.state,
    stage: raw.stage ?? null,
    booksTotal: raw.booksTotal ?? 0,
    booksProcessed: raw.booksProcessed ?? 0,
    conceptsExtracted: raw.conceptsExtracted ?? 0,
    targetCollection: raw.targetCollection ?? null,
    extractModel: raw.extractModel ?? null,
    exportFileId: raw.exportFileId ?? null,
    error: raw.error ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

export interface ListExportsOptions {
  limit?: number;
  offset?: number;
  /** When true, restricts to state="done" with exportFileId set. */
  completedOnly?: boolean;
}

export async function listExports(
  userId: string,
  opts: ListExportsOptions = {},
): Promise<{ rows: DatasetJobDoc[]; total: number }> {
  const { databases, databaseId } = getAppwrite();
  const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, opts.limit ?? PAGE_LIMIT_DEFAULT));
  const offset = Math.max(0, opts.offset ?? 0);

  const queries: string[] = [
    Query.equal("userId", userId),
    Query.orderDesc("createdAt"),
    Query.limit(limit),
    Query.offset(offset),
  ];
  if (opts.completedOnly) {
    queries.push(Query.equal("state", "done"));
    queries.push(Query.isNotNull("exportFileId"));
  }

  const list = await databases.listDocuments<RawDatasetJob>(
    databaseId,
    COLLECTIONS.datasetJobs,
    queries,
  );
  return { rows: list.documents.map(toJob), total: list.total };
}

export async function getExportJob(
  userId: string,
  jobId: string,
): Promise<DatasetJobDoc | null> {
  const { databases, databaseId } = getAppwrite();
  try {
    const raw = await databases.getDocument<RawDatasetJob>(
      databaseId,
      COLLECTIONS.datasetJobs,
      jobId,
    );
    if (raw.userId !== userId) return null;
    return toJob(raw);
  } catch (err) {
    if (isAppwriteCode(err, 404)) return null;
    throw err;
  }
}

export interface JsonlHeadLine {
  raw: string;
  parsed: unknown | null;
}

export interface JsonlHeadResult {
  lines: JsonlHeadLine[];
  truncated: boolean;
}

const MAX_LINE_LIMIT = 200;

/**
 * Stream the first N JSONL lines from a dataset-exports bucket file.
 *
 * Implementation note: Appwrite's storage.getFileDownload() returns the
 * full file body (no range support exposed via SDK), so we accept the
 * wasted bandwidth on large exports for now. Replace with a streaming
 * fetch + early-return when Appwrite SDK gains range download.
 */
export async function readJsonlHead(
  userId: string,
  fileId: string,
  limitRaw: number,
): Promise<JsonlHeadResult | null> {
  const limit = Math.min(MAX_LINE_LIMIT, Math.max(1, Math.floor(limitRaw)));
  const { storage } = getAppwrite();
  /* Ownership check via dataset_jobs lookup BEFORE downloading bytes —
   * cheaper to refuse early than to fetch and discard a 100MB file. */
  const owns = await ownsExportFile(userId, fileId);
  if (!owns) return null;

  let bytes: Uint8Array;
  try {
    const view = await storage.getFileDownload(BUCKETS.datasetExports, fileId);
    bytes = view instanceof Uint8Array ? view : new Uint8Array(view as ArrayBuffer);
  } catch (err) {
    if (isAppwriteCode(err, 404)) return null;
    throw err;
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(bytes);
  const rawLines = text.split("\n");
  const lines: JsonlHeadLine[] = [];
  for (const rawLine of rawLines) {
    if (lines.length >= limit) break;
    const trimmed = rawLine.replace(/\r$/, "");
    if (trimmed === "") continue;
    let parsed: unknown | null = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
    lines.push({ raw: trimmed, parsed });
  }
  return { lines, truncated: rawLines.length > lines.length };
}

async function ownsExportFile(userId: string, fileId: string): Promise<boolean> {
  const { databases, databaseId } = getAppwrite();
  const matches = await databases.listDocuments<RawDatasetJob>(
    databaseId,
    COLLECTIONS.datasetJobs,
    [
      Query.equal("userId", userId),
      Query.equal("exportFileId", fileId),
      Query.limit(1),
    ],
  );
  return matches.documents.length > 0;
}
