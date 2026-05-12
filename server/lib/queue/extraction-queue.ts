import { extractBookViaBridge } from "../library/extractor-bridge.js";
import { publishUser } from "../realtime/event-bus.js";
import {
  createJob,
  getJob,
  getJobRaw,
  listQueuedJobs,
  transitionJob,
  updateJob,
} from "./job-store.js";
import { isTerminalState, type JobDoc } from "./types.js";

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
   * Read state=queued jobs из Appwrite при boot и добавь в pending[].
   * Идемпотентно — повторный вызов в running-worker no-op (pending уже
   * содержит эти IDs ИЛИ они уже в active).
   */
  async resumeFromAppwrite(): Promise<number> {
    const queued = await listQueuedJobs();
    let added = 0;
    for (const job of queued) {
      if (this.pending.includes(job.id)) continue;
      if (this.active.has(job.id)) continue;
      this.pending.push(job.id);
      added += 1;
    }
    if (added > 0 && !this.running) {
      setImmediate(() => void this.drain());
    }
    return added;
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
        /* cancel() уже transition'нёт; не переписываем. */
        await updateJob(jobId, {
          stage: "cancelled",
          conceptsExtracted: result.conceptsAccepted,
        });
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
    .then((count) => {
      if (count > 0) {
        console.log(`[extraction-queue] resumed ${count} queued jobs from Appwrite`);
      }
    })
    .catch((err) => {
      console.warn(
        "[extraction-queue] resumeFromAppwrite failed:",
        err instanceof Error ? err.message : err,
      );
    });
}
