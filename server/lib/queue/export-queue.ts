import { COLLECTIONS, getDatastore, isStoreErrorCode } from "../datastore.js";
import { runDatasetBuild } from "../datasets/build-bridge.js";
import type { DatasetFormat } from "../datasets/synthesize.js";
import { publishUser } from "../realtime/event-bus.js";
import {
  createExportJob,
  getJob,
  getJobRaw,
  isExportJobStage,
  listQueuedJobs,
  listStaleRunningJobs,
  touchJob,
  transitionJob,
  updateJob,
} from "./job-store.js";
import { isTerminalState, type JobDoc } from "./types.js";

/**
 * Phase 8b — background worker for dataset export builds.
 *
 * Why a separate queue from extraction-queue:
 *   - Different work shape: extraction is per-book, often CPU+LLM heavy
 *     across many chapters. Export is collection-wide, dominated by
 *     either Appwrite paging (JSONL) or per-concept LLM calls
 *     (sharegpt/chatml). Mixing them in one FIFO means a 50-book
 *     extraction starves an export click for an hour.
 *   - Different cancel semantics: export cancel must skip the bucket
 *     upload to avoid orphan files; extraction cancel just abandons
 *     work in progress, no external side effect.
 *   - Different orphan-reset window: a stuck export sitting in
 *     "running" because the user kicked the worker mid-LLM-call should
 *     resume on the next boot exactly like extraction does.
 *
 * Both queues share the `dataset_jobs` Appwrite collection. The two
 * are distinguished by the `stage` field — export jobs are tagged
 * `build:<format>` from creation. `resumeFromStore` filters on
 * that prefix so each queue picks up only its own queued docs after
 * a backend restart.
 *
 * State machine identical to extraction-queue (queued → running →
 * done/failed/cancelled), enforced via `transitionJob`'s canTransition
 * check.
 */

const STALE_TIMEOUT_MS = 5 * 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

class ExportQueueImpl {
  private pending: string[] = [];
  private pendingHead = 0;
  private active = new Map<string, AbortController>();
  private running = false;

  private effectivePendingLength(): number {
    return this.pending.length - this.pendingHead;
  }

  private dequeuePending(): string | undefined {
    if (this.pendingHead >= this.pending.length) return undefined;
    const id = this.pending[this.pendingHead];
    this.pending[this.pendingHead] = "";
    this.pendingHead += 1;
    if (this.pendingHead > 64 && this.pendingHead * 2 > this.pending.length) {
      this.pending = this.pending.slice(this.pendingHead);
      this.pendingHead = 0;
    }
    return id;
  }

  /**
   * Enqueue a new export build. Returns the created JobDoc (state=queued)
   * immediately; the worker drains in the background. Caller hands the
   * jobId back to the HTTP client so it can poll /exports/:id or
   * subscribe to the SSE stream.
   */
  async enqueue(input: {
    userId: string;
    collection: string;
    format: DatasetFormat;
  }): Promise<JobDoc> {
    const job = await createExportJob({
      userId: input.userId,
      collection: input.collection,
      format: input.format,
    });
    publishUser(input.userId, "extractor_events:created", {
      jobId: job.id,
      event: "queued",
      payload: {
        kind: "dataset_build",
        collection: input.collection,
        format: input.format,
      },
    });
    this.pending.push(job.id);
    if (!this.running) {
      setImmediate(() => void this.drain());
    }
    return job;
  }

  async cancel(userId: string, jobId: string): Promise<boolean> {
    const job = await getJob(userId, jobId);
    if (!job) return false;
    if (isTerminalState(job.state)) return false;
    const ctrl = this.active.get(jobId);
    if (ctrl) ctrl.abort("user-cancel");
    const ok = await transitionJob(jobId, "cancelled", { stage: "cancelled" });
    if (ok) {
      publishUser(userId, "extractor_events:created", {
        jobId,
        event: "cancelled",
        payload: { kind: "dataset_build" },
      });
    }
    return ok;
  }

  /**
   * Two-phase boot recovery for export builds:
   *   1. Orphan reset: jobs stuck in state="running" with stale
   *      updatedAt → back to queued.
   *   2. Queued resume: queued jobs from prior session → pending FIFO.
   *
   * Both phases filter on `isExportJobStage(stage)` so this queue
   * picks up only export builds, leaving extraction-queue's queued
   * docs alone.
   */
  async resumeFromStore(): Promise<{
    orphansReset: number;
    queuedAdded: number;
  }> {
    let orphansReset = 0;
    try {
      const stale = await listStaleRunningJobs(STALE_TIMEOUT_MS);
      for (const job of stale) {
        if (!isExportJobStage(job.stage)) continue;
        /* Preserve the build:<format> stage so the rerun targets the
         * same format the user originally requested. */
        const ok = await transitionJob(job.id, "queued", { stage: job.stage ?? "build:jsonl" });
        if (ok) {
          orphansReset += 1;
          publishUser(job.userId, "extractor_events:created", {
            jobId: job.id,
            event: "queued",
            payload: { kind: "dataset_build", reason: "orphan-reset" },
          });
        }
      }
    } catch (err) {
      console.warn(
        "[export-queue] listStaleRunningJobs failed:",
        err instanceof Error ? err.message : err,
      );
    }

    const queued = await listQueuedJobs();
    let queuedAdded = 0;
    for (const job of queued) {
      if (!isExportJobStage(job.stage)) continue;
      if (this.pending.indexOf(job.id, this.pendingHead) !== -1) continue;
      if (this.active.has(job.id)) continue;
      this.pending.push(job.id);
      queuedAdded += 1;
    }
    if (queuedAdded > 0 && !this.running) {
      setImmediate(() => void this.drain());
    }
    return { orphansReset, queuedAdded };
  }

  _resetForTesting(): void {
    this.pending.length = 0;
    this.pendingHead = 0;
    for (const ctrl of this.active.values()) {
      ctrl.abort("test-reset");
    }
    this.active.clear();
    this.running = false;
  }

  getDepth(): { pending: number; active: number } {
    return {
      pending: this.effectivePendingLength(),
      active: this.active.size,
    };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const jobId = this.dequeuePending();
        if (!jobId) break;
        await this.processOne(jobId);
      }
    } finally {
      this.running = false;
    }
  }

  private async processOne(jobId: string): Promise<void> {
    const job = await getJobRaw(jobId);
    if (!job) return;
    if (job.state !== "queued") return;
    if (!isExportJobStage(job.stage)) return; /* belt-and-braces: not ours */

    const claimed = await transitionJob(jobId, "running", { stage: job.stage ?? "build:jsonl" });
    if (!claimed) return;

    const format: DatasetFormat = parseFormatFromStage(job.stage) ?? "jsonl";
    const collection = job.targetCollection ?? "";
    if (!collection) {
      /* Defensive: createExportJob always sets targetCollection; a
       * missing one means someone hand-mutated the doc. Fail fast,
       * don't try to build an empty collection. */
      await transitionJob(jobId, "failed", {
        stage: "failed",
        error: "missing_target_collection",
      });
      return;
    }

    const ctrl = new AbortController();
    this.active.set(jobId, ctrl);
    publishUser(job.userId, "extractor_events:created", {
      jobId,
      event: "started",
      payload: {
        kind: "dataset_build",
        collection,
        format,
      },
    });

    const heartbeat = setInterval(() => {
      void touchJob(jobId).catch((err) => {
        console.warn(
          `[export-queue] heartbeat failed for ${jobId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    try {
      const result = await runDatasetBuild({
        jobId,
        userId: job.userId,
        collectionName: collection,
        format,
        signal: ctrl.signal,
      });

      if (ctrl.signal.aborted || result.cancelled) {
        const transitioned = await transitionJob(jobId, "cancelled", {
          stage: "cancelled",
        });
        if (!transitioned) {
          await updateJob(jobId, { stage: "cancelled" });
        }
        publishUser(job.userId, "extractor_events:created", {
          jobId,
          event: "cancelled",
          payload: { kind: "dataset_build" },
        });
      } else if (result.ok && result.exportFileId !== undefined) {
        await transitionJob(jobId, "done", {
          stage: "done",
          conceptsExtracted: result.lineCount ?? 0,
        });
        /* Followup write so exportFileId lands on the doc. Not a state
         * transition (already terminal), and exportFileId is not in
         * UpdateJobPatch — direct Appwrite call scoped to this field. */
        await writeExportFileMeta(jobId, result.exportFileId, result.lineCount ?? 0);
        publishUser(job.userId, "extractor_events:created", {
          jobId,
          event: "done",
          payload: {
            kind: "dataset_build",
            format,
            lineCount: result.lineCount,
            bytes: result.bytes,
            exportFileId: result.exportFileId,
          },
        });
      } else {
        await transitionJob(jobId, "failed", {
          stage: "failed",
          error: (result.error ?? "build returned ok=false").slice(0, 1800),
        });
        publishUser(job.userId, "extractor_events:created", {
          jobId,
          event: "failed",
          payload: {
            kind: "dataset_build",
            reason: result.error ?? "build returned ok=false",
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await transitionJob(jobId, "failed", {
        stage: "failed",
        error: msg.slice(0, 1800),
      });
      publishUser(job.userId, "extractor_events:created", {
        jobId,
        event: "failed",
        payload: { kind: "dataset_build", reason: msg },
      });
    } finally {
      clearInterval(heartbeat);
      this.active.delete(jobId);
    }
  }
}

/**
 * Decode the `build:<format>` stage convention back to a typed
 * DatasetFormat. Returns null on malformed or unknown formats so the
 * worker can fail fast rather than guess. Exported for direct testing.
 */
export function parseFormatFromStage(stage: string | null): DatasetFormat | null {
  if (!stage || !stage.startsWith("build:")) return null;
  const fmt = stage.slice("build:".length);
  if (fmt === "jsonl" || fmt === "sharegpt" || fmt === "chatml") return fmt;
  return null;
}

/**
 * Write exportFileId + conceptsExtracted to the job doc post-completion.
 * Separated from transitionJob because `state` is already terminal at
 * this point — canTransition would refuse, but we still want the file
 * pointer persisted so /exports/:id/download can find the artifact.
 *
 * Bypasses the UpdateJobPatch surface (which doesn't expose exportFileId
 * — that field is export-only and would pollute the extraction patch
 * type). Direct Appwrite call, scoped to this one field.
 */
async function writeExportFileMeta(
  jobId: string,
  exportFileId: string,
  lineCount: number,
): Promise<void> {
  const { databases, databaseId } = getDatastore();
  try {
    await databases.updateDocument(databaseId, COLLECTIONS.datasetJobs, jobId, {
      exportFileId,
      conceptsExtracted: lineCount,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (!isStoreErrorCode(err, 404)) throw err;
  }
}

const queue = new ExportQueueImpl();

export function getExportQueue(): ExportQueueImpl {
  return queue;
}

/**
 * Server bootstrap — after buildApp / serve(), call this to re-enqueue
 * export builds queued in the previous session. Fire-and-forget; errors
 * are logged but don't block startup.
 */
export function startExportWorker(): void {
  void queue
    .resumeFromStore()
    .then(({ orphansReset, queuedAdded }) => {
      if (orphansReset > 0) {
        console.log(
          `[export-queue] reset ${orphansReset} stale 'running' build jobs (orphans) to queued`,
        );
      }
      if (queuedAdded > 0) {
        console.log(
          `[export-queue] resumed ${queuedAdded} queued build jobs from Appwrite`,
        );
      }
    })
    .catch((err) => {
      console.warn(
        "[export-queue] resumeFromStore failed:",
        err instanceof Error ? err.message : err,
      );
    });
}
