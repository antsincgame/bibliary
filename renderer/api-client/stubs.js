/**
 * Stubs for namespaces that need either Realtime (Phase 3b) or LLM
 * provider abstraction (Phase 6) — exposed by the api-client so the
 * renderer destructure doesn't blow up at import time.
 */

const noopUnsubscribe = () => undefined;
const notImplemented = (namespace, name) => async () => {
  throw new Error(`${namespace}.${name} not yet implemented in web mode`);
};

/** Electron native menu — replaced by side-nav clicks in web. */
export const appMenu = {
  /** @param {(route: string) => void} _cb */
  onNavigate: (_cb) => noopUnsubscribe,
};

/** Resilience push events — Phase 3b Realtime adapter. */
export const resilience = {
  /** @param {() => void} _cb */
  onLmstudioOffline: (_cb) => noopUnsubscribe,
  /** @param {() => void} _cb */
  onLmstudioOnline: (_cb) => noopUnsubscribe,
  /** @param {(snapshot: unknown) => void} _cb */
  onSchedulerSnapshot: (_cb) => noopUnsubscribe,
  /** @param {(snapshot: unknown) => void} _cb */
  onModelPoolSnapshot: (_cb) => noopUnsubscribe,
  /** @param {(snapshot: unknown) => void} _cb */
  onLmstudioPressure: (_cb) => noopUnsubscribe,
};

/**
 * dataset-v2 — full pipeline зависит от Phase 6 (LLM providers) и
 * Phase 2m (background worker + ingest_jobs progress). До тех пор:
 *   - start-* throws not_implemented
 *   - cancel-* / list-accepted возвращают пустые ответы — UI должен
 *     gracefully показать «no data» вместо краша.
 */
export const datasetV2 = {
  startBatch: notImplemented("datasetV2", "startBatch"),
  startExtraction: notImplemented("datasetV2", "startExtraction"),
  synthesize: notImplemented("datasetV2", "synthesize"),

  cancel: async () => false,
  cancelBatch: async () => false,

  listAccepted: async (collection) => ({
    total: 0,
    byDomain: {},
    collection: collection ?? "default",
  }),
  rejectAccepted: async () => false,

  /** @param {(ev: unknown) => void} _cb */
  onEvent: (_cb) => noopUnsubscribe,

  /** Electron native picker / shell. */
  pickExportDir: notImplemented("datasetV2", "pickExportDir"),
  openFolder: notImplemented("datasetV2", "openFolder"),
};
