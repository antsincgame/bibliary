/**
 * Stubs / Realtime wirings — namespaces backed by SSE через
 * /api/events. Pure stubs остались только для namespace'ов которые
 * зависят от Phase 6 (LLM providers — dataset-v2).
 */

import { subscribe } from "./realtime.js";

const noopUnsubscribe = () => undefined;
const notImplemented = (namespace, name) => async () => {
  throw new Error(`${namespace}.${name} not yet implemented in web mode`);
};

/** Electron native menu — replaced by side-nav clicks in web. */
export const appMenu = {
  /** @param {(route: string) => void} _cb */
  onNavigate: (_cb) => noopUnsubscribe,
};

/** Resilience push events — SSE channels из EventSink в server/main. */
export const resilience = {
  /** @param {() => void} cb */
  onLmstudioOffline: (cb) => subscribe("resilience:lmstudio-offline", () => cb()),
  /** @param {() => void} cb */
  onLmstudioOnline: (cb) => subscribe("resilience:lmstudio-online", () => cb()),
  /** @param {(snapshot: unknown) => void} cb */
  onSchedulerSnapshot: (cb) => subscribe("resilience:scheduler-snapshot", cb),
  /** @param {(snapshot: unknown) => void} cb */
  onModelPoolSnapshot: (cb) => subscribe("resilience:model-pool-snapshot", cb),
  /** @param {(snapshot: unknown) => void} cb */
  onLmstudioPressure: (cb) => subscribe("resilience:lmstudio-pressure", cb),
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
