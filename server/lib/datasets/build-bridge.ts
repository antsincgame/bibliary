import { ID, Permission, Role } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";
import { publishUser } from "../realtime/event-bus.js";
import { buildJsonlBuffer, type DatasetFormat } from "./synthesize.js";

/**
 * Phase 8 bridge: trigger dataset build → синтезирует JSONL поток
 * concepts → uploads в `dataset-exports` bucket → updates dataset_jobs
 * document со exportFileId. Renderer poll'ит /jobs/:id или подписан
 * на extractor_events:created channel (kind="dataset_build").
 *
 * State machine job: queued → running → done/failed. Same dataset_jobs
 * collection как extraction queue (Phase 7) — caller различает по
 * targetCollection name + extractModel field (extraction ставит
 * extractor model, build не ставит).
 */

export interface BuildDatasetResult {
  ok: boolean;
  jobId: string;
  exportFileId?: string;
  lineCount?: number;
  bytes?: number;
  warnings: string[];
  error?: string;
}

type RawJob = RawDoc & {
  userId: string;
  state: string;
  exportFileId?: string;
};

async function createBuildJob(
  userId: string,
  collectionName: string,
  format: DatasetFormat,
): Promise<string> {
  const { databases, databaseId } = getAppwrite();
  const nowIso = new Date().toISOString();
  const doc = await databases.createDocument(
    databaseId,
    COLLECTIONS.datasetJobs,
    ID.unique(),
    {
      userId,
      state: "running",
      stage: `build:${format}`,
      booksTotal: 0,
      booksProcessed: 0,
      conceptsExtracted: 0,
      targetCollection: collectionName,
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

async function markBuildDone(
  jobId: string,
  exportFileId: string,
  lineCount: number,
): Promise<void> {
  const { databases, databaseId } = getAppwrite();
  try {
    await databases.updateDocument(databaseId, COLLECTIONS.datasetJobs, jobId, {
      state: "done",
      stage: "done",
      exportFileId,
      conceptsExtracted: lineCount,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (!isAppwriteCode(err, 404)) throw err;
  }
}

async function markBuildFailed(jobId: string, error: string): Promise<void> {
  const { databases, databaseId } = getAppwrite();
  try {
    await databases.updateDocument(databaseId, COLLECTIONS.datasetJobs, jobId, {
      state: "failed",
      stage: "failed",
      error: error.slice(0, 1800),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (!isAppwriteCode(err, 404)) throw err;
  }
}

async function uploadJsonl(
  userId: string,
  collectionName: string,
  format: DatasetFormat,
  jsonl: string,
): Promise<{ fileId: string; bytes: number }> {
  const { storage } = getAppwrite();
  const fileId = ID.unique();
  const buf = Buffer.from(jsonl, "utf-8");
  const filename = `${collectionName}-${Date.now()}.${format}`;
  const file = await storage.createFile(
    BUCKETS.datasetExports,
    fileId,
    InputFile.fromBuffer(buf, filename),
    [
      Permission.read(Role.user(userId)),
      Permission.update(Role.user(userId)),
      Permission.delete(Role.user(userId)),
      Permission.read(Role.team("admin")),
    ],
  );
  return { fileId: file.$id, bytes: buf.byteLength };
}

export interface BuildDatasetInput {
  userId: string;
  collectionName: string;
  format?: DatasetFormat;
}

/**
 * Synchronous build (in-process). 100-1000 concepts → ~5-10s. Для
 * very large экспортов (>10K concepts) подойдёт streaming variant
 * чтобы не накапливать буфер в RAM — отдельный коммит когда понадобится.
 */
export async function buildDataset(
  input: BuildDatasetInput,
): Promise<BuildDatasetResult> {
  const format: DatasetFormat = input.format ?? "jsonl";
  if (format !== "jsonl") {
    return {
      ok: false,
      jobId: "",
      warnings: [],
      error: `format_not_supported:${format}`,
    };
  }

  const jobId = await createBuildJob(input.userId, input.collectionName, format);
  publishUser(input.userId, "extractor_events:created", {
    jobId,
    event: "started",
    payload: {
      kind: "dataset_build",
      collection: input.collectionName,
      format,
    },
  });

  try {
    const { jsonl, lineCount, warnings } = await buildJsonlBuffer({
      userId: input.userId,
      collectionName: input.collectionName,
    });
    if (lineCount === 0) {
      await markBuildFailed(jobId, "no_concepts_in_collection");
      publishUser(input.userId, "extractor_events:created", {
        jobId,
        event: "failed",
        payload: {
          kind: "dataset_build",
          reason: "collection is empty (no accepted concepts)",
        },
      });
      return {
        ok: false,
        jobId,
        warnings,
        error: "no_concepts_in_collection",
      };
    }

    const { fileId, bytes } = await uploadJsonl(
      input.userId,
      input.collectionName,
      format,
      jsonl,
    );
    await markBuildDone(jobId, fileId, lineCount);
    publishUser(input.userId, "extractor_events:created", {
      jobId,
      event: "done",
      payload: {
        kind: "dataset_build",
        format,
        lineCount,
        bytes,
        exportFileId: fileId,
      },
    });
    return {
      ok: true,
      jobId,
      exportFileId: fileId,
      lineCount,
      bytes,
      warnings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markBuildFailed(jobId, msg);
    publishUser(input.userId, "extractor_events:created", {
      jobId,
      event: "failed",
      payload: { kind: "dataset_build", reason: msg },
    });
    return { ok: false, jobId, warnings: [], error: msg };
  }
}

export async function downloadExport(
  userId: string,
  jobId: string,
): Promise<{ body: Uint8Array<ArrayBuffer>; filename: string; size: number } | null> {
  const { databases, databaseId, storage } = getAppwrite();
  let job: RawJob;
  try {
    job = await databases.getDocument<RawJob>(databaseId, COLLECTIONS.datasetJobs, jobId);
  } catch (err) {
    if (isAppwriteCode(err, 404)) return null;
    throw err;
  }
  if (job.userId !== userId) return null;
  if (!job.exportFileId) return null;
  try {
    const view = await storage.getFileDownload(BUCKETS.datasetExports, job.exportFileId);
    /* Coerce to Uint8Array<ArrayBuffer> explicitly — Hono c.body() требует
     * narrow ArrayBuffer variant, не ArrayBufferLike (mismatched
     * SharedArrayBuffer). */
    const src = view instanceof Uint8Array ? view : new Uint8Array(view as ArrayBuffer);
    const ab = new ArrayBuffer(src.byteLength);
    const body = new Uint8Array(ab);
    body.set(src);
    const meta = await storage.getFile(BUCKETS.datasetExports, job.exportFileId);
    return {
      body,
      filename: meta.name || `${jobId}.jsonl`,
      size: body.byteLength,
    };
  } catch (err) {
    if (isAppwriteCode(err, 404)) return null;
    throw err;
  }
}
