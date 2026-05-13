import { ID, Permission, Role } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import { withProvider } from "../llm/model-resolver.js";
import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";
import { publishUser } from "../realtime/event-bus.js";
import { renderChatMlLine } from "./chatml.js";
import {
  buildTieredLines,
  dedupShareGptLines,
  generateTieredQA,
  type ShareGptLine,
} from "./sharegpt.js";
import { openTempJsonlWriter } from "./stream-writer.js";
import {
  iterateAcceptedConcepts,
  type DatasetFormat,
} from "./synthesize.js";

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

async function uploadFromPath(
  userId: string,
  filename: string,
  filePath: string,
): Promise<{ fileId: string }> {
  const { storage } = getAppwrite();
  const fileId = ID.unique();
  const file = await storage.createFile(
    BUCKETS.datasetExports,
    fileId,
    InputFile.fromPath(filePath, filename),
    [
      Permission.read(Role.user(userId)),
      Permission.update(Role.user(userId)),
      Permission.delete(Role.user(userId)),
      Permission.read(Role.team("admin")),
    ],
  );
  return { fileId: file.$id };
}

function buildFilename(collection: string, format: DatasetFormat): string {
  const ts = Date.now();
  const ext = format === "chatml" ? "chatml.jsonl" : format === "sharegpt" ? "sharegpt.jsonl" : "jsonl";
  return `${collection}-${ts}.${ext}`;
}

export interface BuildDatasetInput {
  userId: string;
  collectionName: string;
  format?: DatasetFormat;
}

/**
 * Streaming build (Phase 8d). Пишет JSONL в temp file построчно — RAM
 * footprint O(1) regardless of dataset size. Upload через
 * InputFile.fromPath; temp dir cleaned в finally.
 *
 * Поддерживает три format:
 *   - jsonl:    direct dump DeltaKnowledge без LLM, instant.
 *   - sharegpt: per-concept LLM Q&A через crystallizer role.
 *   - chatml:   same Q&A, rendered как <|im_start|>...<|im_end|> template
 *               в `text` field (HuggingFace SFT convention).
 */
export async function buildDataset(
  input: BuildDatasetInput,
): Promise<BuildDatasetResult> {
  const format: DatasetFormat = input.format ?? "jsonl";
  if (format !== "jsonl" && format !== "sharegpt" && format !== "chatml") {
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

  const filename = buildFilename(input.collectionName, format);
  const writer = await openTempJsonlWriter(filename);
  const warnings: string[] = [];
  let lineCount = 0;

  try {
    if (format === "jsonl") {
      for await (const src of iterateAcceptedConcepts({
        userId: input.userId,
        collectionName: input.collectionName,
        onWarning: (w) => warnings.push(w),
      })) {
        await writer.writeLine(JSON.stringify(src));
        lineCount += 1;
      }
    } else {
      /* sharegpt + chatml — multi-tier Q&A (Phase 8e). One LLM call
       * per concept → T1+T2+T3 lines. Final Jaccard dedup pass дропает
       * accidental rephrasings. */
      const sourceLines: Array<Awaited<ReturnType<typeof iterateAcceptedConcepts>> extends AsyncGenerator<infer T> ? T : never> = [];
      for await (const src of iterateAcceptedConcepts({
        userId: input.userId,
        collectionName: input.collectionName,
        onWarning: (w) => warnings.push(w),
      })) {
        sourceLines.push(src);
      }

      /** Buffer всех ShareGptLines до dedup. Multi-tier ↑3× concept_count. */
      const bufferedLines: ShareGptLine[] = [];

      if (sourceLines.length > 0) {
        await withProvider(input.userId, "crystallizer", async (provider, model) => {
          let processed = 0;
          for (const src of sourceLines) {
            try {
              const tiered = await generateTieredQA(provider, model, src.delta);
              if (!tiered) {
                warnings.push(`concept ${src.conceptId}: tiered QA generation failed`);
                continue;
              }
              bufferedLines.push(...buildTieredLines(src, tiered));
            } catch (err) {
              warnings.push(
                `concept ${src.conceptId}: synthesizer threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            } finally {
              processed += 1;
              publishUser(input.userId, "extractor_events:created", {
                jobId,
                event: "progress",
                payload: {
                  kind: "dataset_build",
                  format,
                  done: processed,
                  total: sourceLines.length,
                },
              });
            }
          }
        });
      }

      /* Jaccard dedup pass — within-tier similarity > 0.92 → drop. */
      const { kept, dropped } = dedupShareGptLines(bufferedLines, 0.92);
      if (dropped > 0) {
        warnings.push(`dedup: dropped ${dropped} near-duplicate lines (Jaccard > 0.92)`);
      }
      for (const sharegptLine of kept) {
        const output =
          format === "chatml" ? renderChatMlLine(sharegptLine) : sharegptLine;
        await writer.writeLine(JSON.stringify(output));
        lineCount += 1;
      }
    }

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

    const { path, bytes } = await writer.finish();
    const { fileId } = await uploadFromPath(input.userId, filename, path);

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
    return { ok: false, jobId, warnings, error: msg };
  } finally {
    await writer.cleanup();
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
