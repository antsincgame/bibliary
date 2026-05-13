/**
 * Stubs / Realtime wirings — namespaces backed by SSE through
 * /api/events. Phase 13a: the datasetV2 namespace (legacy Electron
 * crystallization wizard) is gone; only the realtime fan-outs for
 * resilience push events and the menu-navigation no-op remain.
 */

import { subscribe } from "./realtime.js";

const noopUnsubscribe = () => undefined;

/** Electron native menu — replaced by side-nav clicks in web. */
export const appMenu = {
  /** @param {(route: string) => void} _cb */
  onNavigate: (_cb) => noopUnsubscribe,
};

/** Resilience push events — SSE channels from EventSink in server/main. */
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
