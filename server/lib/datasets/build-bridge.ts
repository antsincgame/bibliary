import { ID, Permission, Role } from "../store/query.js";
import { InputFile } from "../store/input-file.js";

import { withProvider } from "../llm/model-resolver.js";
import { BUCKETS, COLLECTIONS, getDatastore, isStoreErrorCode, type RawDoc } from "../datastore.js";
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
 * Phase 8 bridge: synthesize accepted concepts → temp JSONL → upload to
 * `dataset-exports` bucket. As of Phase 8b the build runs from the
 * export-queue worker (not the HTTP request thread): the queue owns
 * job lifecycle (queued → running → done/failed/cancelled) and just
 * calls `runDatasetBuild` to do the actual streaming + LLM work for a
 * job that already exists. Caller passes a `signal` so the build can
 * be cancelled mid-flight without leaving Appwrite Storage litter.
 */

export interface BuildDatasetResult {
  ok: boolean;
  exportFileId?: string;
  lineCount?: number;
  bytes?: number;
  warnings: string[];
  error?: string;
  cancelled?: boolean;
}

type RawJob = RawDoc & {
  userId: string;
  state: string;
  exportFileId?: string;
};

async function uploadFromPath(
  userId: string,
  filename: string,
  filePath: string,
): Promise<{ fileId: string }> {
  const { storage } = getDatastore();
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

export interface RunDatasetBuildInput {
  /** Pre-created dataset_jobs document id; queue owns lifecycle transitions. */
  jobId: string;
  userId: string;
  collectionName: string;
  format: DatasetFormat;
  /** Abort to cancel mid-build; the build returns `cancelled: true`. */
  signal?: AbortSignal;
}

/**
 * Streaming build executor. Pure work — does NOT touch dataset_jobs
 * state (queue does that). Writes line-by-line to a temp file
 * (RAM O(1) regardless of dataset size), uploads via InputFile.fromPath,
 * cleans the temp dir in `finally`. Honours `signal`: aborts return
 * `cancelled: true` before any bucket upload happens, so cancel never
 * leaves a partial export file on storage.
 *
 * Supports three formats:
 *   - jsonl:    direct dump DeltaKnowledge без LLM, instant.
 *   - sharegpt: per-concept LLM Q&A через crystallizer role.
 *   - chatml:   same Q&A, rendered как <|im_start|>...<|im_end|> template
 *               в `text` field (HuggingFace SFT convention).
 */
export async function runDatasetBuild(
  input: RunDatasetBuildInput,
): Promise<BuildDatasetResult> {
  const { jobId, format, signal } = input;
  if (format !== "jsonl" && format !== "sharegpt" && format !== "chatml") {
    return {
      ok: false,
      warnings: [],
      error: `format_not_supported:${format}`,
    };
  }

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
        ...(signal ? { signal } : {}),
      })) {
        if (signal?.aborted) return { ok: false, warnings, cancelled: true };
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
        ...(signal ? { signal } : {}),
      })) {
        if (signal?.aborted) return { ok: false, warnings, cancelled: true };
        sourceLines.push(src);
      }

      /** Buffer всех ShareGptLines до dedup. Multi-tier ↑3× concept_count. */
      const bufferedLines: ShareGptLine[] = [];

      if (sourceLines.length > 0 && !signal?.aborted) {
        await withProvider(input.userId, "crystallizer", async (provider, model) => {
          let processed = 0;
          for (const src of sourceLines) {
            if (signal?.aborted) break;
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

      if (signal?.aborted) return { ok: false, warnings, cancelled: true };

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

    if (signal?.aborted) return { ok: false, warnings, cancelled: true };

    if (lineCount === 0) {
      return {
        ok: false,
        warnings,
        error: "no_concepts_in_collection",
      };
    }

    const { path, bytes } = await writer.finish();
    /* One last cancel check before the bucket upload — bucket writes
     * are not abortable, so this is the last bail-out point that
     * avoids litter in `dataset-exports`. */
    if (signal?.aborted) return { ok: false, warnings, cancelled: true };
    const { fileId } = await uploadFromPath(input.userId, filename, path);

    return {
      ok: true,
      exportFileId: fileId,
      lineCount,
      bytes,
      warnings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warnings, error: msg };
  } finally {
    await writer.cleanup();
  }
}

export async function downloadExport(
  userId: string,
  jobId: string,
): Promise<{ body: Uint8Array<ArrayBuffer>; filename: string; size: number } | null> {
  const { databases, databaseId, storage } = getDatastore();
  let job: RawJob;
  try {
    job = await databases.getDocument<RawJob>(databaseId, COLLECTIONS.datasetJobs, jobId);
  } catch (err) {
    if (isStoreErrorCode(err, 404)) return null;
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
    if (isStoreErrorCode(err, 404)) return null;
    throw err;
  }
}
