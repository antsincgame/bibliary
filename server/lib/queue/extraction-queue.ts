import { extractBookViaBridge } from "../library/extractor-bridge.js";
import { publishUser } from "../realtime/event-bus.js";
import {
  createJob,
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
 * Worker считается ASCII если updatedAt < now - STALE_TIMEOUT. На boot
 * мы reset'нём такие jobs в queued для replay. 5 минут — компромисс:
 *   - меньше → false-positive при медленном Anthropic call (одна глава
 *     может занять 30-90s × pages); если 2-3 главы подряд — 5min
 *     уже close to ceiling.
 *   - больше → жертва UX, jobs дольше остаются «мёртвыми» после crash.
 */
const STALE_TIMEOUT_MS = 5 * 60_000;

/** Heartbeat interval — updates job's updatedAt to defeat stale-detection. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * In-process extraction queue для single-pod backend.
 *
 * Lifecycle:
 *   POST /extract → enqueue() → createJob (Appwrite state=queued) +
 *     pending[].push(jobId) → return jobId сразу
 *
 *   Worker loop (startWorker):
 *     - drain pending[] FIFO
 *     - claim: transitionJob(jobId, "running") — если уже cancelled
 *       (race с POST /cancel), skip job
 *     - run extractBookViaBridge(userId, bookId, {signal})
 *     - finalize: transitionJob → done/failed (extractBookViaBridge
 *       уже обновил book status и публикует SSE).
 *
 *   POST /cancel(jobId):
 *     - active.get(jobId)?.abort() — текущий run прерывается
 *     - transitionJob(jobId, "cancelled") — DB фиксирует
 *
 * State в памяти (pending[], active Map) теряется при рестарте; при
 * boot startWorker() читает state=queued из Appwrite и re-enqueue.
 * Running jobs которые крашнули backend остаются "running" — нужен
 * heartbeat + orphan-cleanup в Phase 7b (или просто rerun guided UI).
 *
 * Single-instance: один worker, no race. Multi-pod заменим на
 * distributed lock (Redis SETNX) — surface не меняется.
 */

class ExtractionQueueImpl {
  private pending: string[] = [];
  private active = new Map<string, AbortController>();
  private running = false;

  /**
   * @returns the freshly created JobDoc (state=queued).
   */
  async enqueue(input: {
    userId: string;
    bookId: string;
    collection?: string;
  }): Promise<JobDoc> {
    const job = await createJob({
      userId: input.userId,
      bookId: input.bookId,
      ...(input.collection ? { collection: input.collection } : {}),
    });
    publishUser(input.userId, "extractor_events:created", {
      bookId: input.bookId,
      jobId: job.id,
      event: "queued",
      payload: {
        kind: "extraction",
        collection: input.collection ?? null,
      },
    });
    this.pending.push(job.id);
    /* setImmediate чтобы caller получил job.id до того как worker
     * начнёт работу — иначе POST /extract → worker → ... → publishUser
     * мог отправить started до того как клиент успел subscribe. */
    if (!this.running) {
      setImmediate(() => void this.drain());
    }
    return job;
  }

  /**
   * Cancel claim:
   *  - state=queued → transition cancelled (worker pickup пропустит)
   *  - state=running → abort signal + transition cancelled (extractor
   *    poll'нёт abort через signal.aborted в extractor-bridge loop)
   *  - state=terminal → no-op return false
   */
  async cancel(userId: string, jobId: string): Promise<boolean> {
    const job = await getJob(userId, jobId);
    if (!job) return false;
    if (isTerminalState(job.state)) return false;
    const ctrl = this.active.get(jobId);
    if (ctrl) ctrl.abort("user-cancel");
    /* DB transition после abort signal — если worker'на проверке
     * успеет проверить state, увидит cancelled. */
    const ok = await transitionJob(jobId, "cancelled", { stage: "cancelled" });
    if (ok) {
      publishUser(userId, "extractor_events:created", {
        bookId: job.bookId,
        jobId,
        event: "cancelled",
      });
    }
    return ok;
  }

  /**
   * Two-phase recovery на boot:
   *   1. Orphan reset: jobs застрявшие в state="running" с stale
   *      updatedAt → transition обратно в queued (worker crashed
   *      mid-extraction). Возвращаются в pending для replay.
   *   2. Queued resume: jobs которые были queued в предыдущей session
   *      → push в pending для drain.
   *
   * Идемпотентно: повторный вызов не дублирует pending entries.
   */
  async resumeFromAppwrite(): Promise<{ orphansReset: number; queuedAdded: number }> {
    let orphansReset = 0;
    try {
      const stale = await listStaleRunningJobs(STALE_TIMEOUT_MS);
      for (const job of stale) {
        /* Phase 8b: dataset_jobs collection now hosts both extraction
         * and export build docs. Skip exports — they have their own
         * queue which preserves the build:<format> stage on reset. */
        if (isExportJobStage(job.stage)) continue;
        const ok = await transitionJob(job.id, "queued", { stage: "orphan-reset" });
        if (ok) {
          orphansReset += 1;
          publishUser(job.userId, "extractor_events:created", {
            bookId: job.bookId,
            jobId: job.id,
            event: "queued",
            payload: { kind: "extraction", reason: "orphan-reset" },
          });
        }
      }
    } catch (err) {
      console.warn(
        "[extraction-queue] listStaleRunningJobs failed:",
        err instanceof Error ? err.message : err,
      );
    }

    const queued = await listQueuedJobs();
    let queuedAdded = 0;
    for (const job of queued) {
      /* Same export-stage filter as the orphan-reset loop above. */
      if (isExportJobStage(job.stage)) continue;
      if (this.pending.includes(job.id)) continue;
      if (this.active.has(job.id)) continue;
      this.pending.push(job.id);
      queuedAdded += 1;
    }
    if (queuedAdded > 0 && !this.running) {
      setImmediate(() => void this.drain());
    }
    return { orphansReset, queuedAdded };
  }

  /** Test helper — reset internal state. */
  _resetForTesting(): void {
    this.pending.length = 0;
    for (const ctrl of this.active.values()) {
      ctrl.abort("test-reset");
    }
    this.active.clear();
    this.running = false;
  }

  getDepth(): { pending: number; active: number } {
    return { pending: this.pending.length, active: this.active.size };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const jobId = this.pending.shift();
        if (!jobId) continue;
        await this.processOne(jobId);
      }
    } finally {
      this.running = false;
    }
  }

  private async processOne(jobId: string): Promise<void> {
    const job = await getJobRaw(jobId);
    if (!job) return; // deleted / orphan
    /* Если уже cancelled (race с POST /cancel до пиклапа) — skip. */
    if (job.state !== "queued") return;
    /* Belt-and-braces: export build docs share the dataset_jobs
     * collection. resumeFromAppwrite filters them out, but if anyone
     * push'ed an export jobId into this.pending by mistake, skip it
     * rather than try to run extractBookViaBridge against a bookId
     * that's null. */
    if (isExportJobStage(job.stage)) return;

    const claimed = await transitionJob(jobId, "running", { stage: "running" });
    if (!claimed) return; // race lost (or cancelled meanwhile)

    const ctrl = new AbortController();
    this.active.set(jobId, ctrl);
    publishUser(job.userId, "extractor_events:created", {
      bookId: job.bookId,
      jobId,
      event: "started",
      payload: {
        kind: "extraction",
        collection: job.targetCollection ?? null,
      },
    });

    /* Heartbeat: каждые 30s touchJob(jobId) → updatedAt свежий. На boot
     * orphan detection не reset'нет нас в queued. Cleared в finally. */
    const heartbeat = setInterval(() => {
      void touchJob(jobId).catch((err) => {
        console.warn(
          `[extraction-queue] heartbeat failed for ${jobId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    try {
      const result = await extractBookViaBridge(
        job.userId,
        job.bookId ?? "",
        {
          ...(job.targetCollection ? { collection: job.targetCollection } : {}),
          signal: ctrl.signal,
        },
      );
      /* Final state: done если bridge вернул ok, иначе failed. Если
       * caller прервал через cancel, abort приведёт extractor-bridge к
       * прерыванию — он return'нёт с conceptsAccepted=0 → state="failed",
       * НО мы уже знаем что cancelled через ctrl.signal.aborted. */
      if (ctrl.signal.aborted) {
        /* cancel() обычно успевает transitionJob раньше — тогда наш
         * вызов вернёт false и мы дополним только counters через updateJob.
         * Если cancel() ещё не дошёл (race), state мог остаться "running" —
         * наш transitionJob его сдвинет. Никогда не оставляем "running"
         * после abort. */
        const transitioned = await transitionJob(jobId, "cancelled", {
          stage: "cancelled",
          conceptsExtracted: result.conceptsAccepted,
        });
        if (!transitioned) {
          await updateJob(jobId, {
            stage: "cancelled",
            conceptsExtracted: result.conceptsAccepted,
          });
        }
      } else if (result.ok) {
        await transitionJob(jobId, "done", {
          stage: "done",
          booksProcessed: 1,
          conceptsExtracted: result.conceptsAccepted,
        });
      } else {
        await transitionJob(jobId, "failed", {
          stage: "failed",
          error: result.error?.slice(0, 1800) ?? "extraction returned ok=false",
          conceptsExtracted: result.conceptsAccepted,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await transitionJob(jobId, "failed", {
        stage: "failed",
        error: msg.slice(0, 1800),
      });
      publishUser(job.userId, "extractor_events:created", {
        bookId: job.bookId,
        jobId,
        event: "failed",
        payload: { reason: msg },
      });
    } finally {
      clearInterval(heartbeat);
      this.active.delete(jobId);
    }
  }
}

const queue = new ExtractionQueueImpl();

export function getExtractionQueue(): ExtractionQueueImpl {
  return queue;
}

/**
 * Server bootstrap — после buildApp / serve() вызвать чтобы re-enqueue
 * queued jobs которые остались с предыдущей session. Fire-and-forget;
 * ошибки логируются, не блокируют startup.
 */
export function startExtractionWorker(): void {
  void queue
    .resumeFromAppwrite()
    .then(({ orphansReset, queuedAdded }) => {
      if (orphansReset > 0) {
        console.log(
          `[extraction-queue] reset ${orphansReset} stale 'running' jobs (orphans) to queued`,
        );
      }
      if (queuedAdded > 0) {
        console.log(
          `[extraction-queue] resumed ${queuedAdded} queued jobs from Appwrite`,
        );
      }
    })
    .catch((err) => {
      console.warn(
        "[extraction-queue] resumeFromAppwrite failed:",
        err instanceof Error ? err.message : err,
      );
    });
}
