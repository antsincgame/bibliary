/**
 * Dataset-v2 / Crystallizer pipeline registration in batch-coordinator.
 *
 * Why: extraction jobs use LM Studio for hours. If LM Studio goes
 * offline mid-job, the watchdog calls coordinator.pauseAll(), which now
 * propagates to extraction via this pipeline -- aborting in-flight LLM
 * calls so the user gets immediate feedback instead of waiting for
 * dozens of failed retries.
 *
 * Unlike dataset/forge, extraction has no on-disk job state (results
 * stream directly to Chroma). So pause = abort, discard = no-op,
 * flushPending = no-op. resume = no-op too (jobs are not mid-flight
 * resumable; the user starts a new job after the issue is resolved).
 */
import { coordinator, type PipelineHandle } from "../resilience/batch-coordinator.js";
import type { CheckpointStore } from "../resilience/checkpoint-store.js";

/**
 * Map of jobId -> AbortController. Owned by the IPC handler; we just
 * read from it via the closure. Public mutator: register / unregister.
 */
const activeJobs = new Map<string, AbortController>();

/**
 * Hook called by dataset-v2.ipc.ts when a job starts. Stores the
 * AbortController so the pipeline can abort it on pause/cancel.
 */
export function trackExtractionJob(jobId: string, controller: AbortController): void {
  activeJobs.set(jobId, controller);
}

/**
 * Hook called when a job ends (success or failure). Cleans up the map.
 */
export function untrackExtractionJob(jobId: string): void {
  activeJobs.delete(jobId);
}

/**
 * Aborts all currently active extraction jobs. Used both by the
 * pipeline pause hook (watchdog) and by abortAllDatasetV2 on shutdown.
 */
export function abortAllExtractionJobs(reason: string): void {
  for (const [id, ctrl] of activeJobs.entries()) {
    ctrl.abort(reason);
    activeJobs.delete(id);
  }
}

/**
 * No-op checkpoint store. Extraction state lives in Chroma (accepted
 * concepts go straight there); no per-job snapshot file is needed. We
 * implement the full interface so PipelineHandle.store is a real value
 * the coordinator can poke at without runtime errors.
 */
const noopStore: CheckpointStore<unknown> = {
  load: async () => null,
  save: async () => undefined,
  remove: async () => undefined,
  scan: async () => [],
  list: async () => [],
  getPath: (id: string) => `extraction:${id}`,
};

export function registerExtractionPipeline(): void {
  const handle: PipelineHandle = {
    name: "extraction",
    store: noopStore,
    pause: async (jobId: string) => {
      /* Watchdog asked us to pause. Crystallizer cannot literally pause
         mid-LLM-call, so we abort -- the IPC handler's try/catch will
         surface the error to the renderer as "stopped by system". User
         can restart after the underlying issue is fixed. */
      const ctrl = activeJobs.get(jobId);
      if (ctrl) ctrl.abort("paused-by-watchdog");
    },
    resume: async () => {
      /* Intentional no-op. Jobs are not mid-flight resumable; the user
         starts a new extraction after the LM Studio issue is fixed. */
    },
    cancel: async (jobId: string) => {
      const ctrl = activeJobs.get(jobId);
      if (ctrl) ctrl.abort("user-cancel");
      activeJobs.delete(jobId);
    },
    discard: async () => {
      /* No on-disk state to discard. */
    },
    flushPending: async () => {
      /* Nothing buffered locally. Each accepted concept is upserted
         immediately into Chroma; the embedder cache flushes on its own. */
    },
  };
  coordinator.registerPipeline(handle);
}
