import { http } from "./http.js";

/**
 * LM Studio bridge. Web-mode: one shared LM Studio instance per server
 * (admin-configured URL). Per-user choice ограничивается выбором роли
 * → modelKey через user_preferences. Phase 6 добавит provider abstraction
 * (Anthropic / OpenAI rooted in user keys).
 */

const notImplemented = (name) => async () => {
  throw new Error(`lmstudio.${name} not yet implemented in web mode`);
};

export const lmstudio = {
  /** @returns {Promise<{online: boolean, url: string, version?: string}>} */
  status: () => http.get("/api/lmstudio/status"),

  listDownloaded: () => http.get("/api/lmstudio/list-downloaded"),
  listLoaded: () => http.get("/api/lmstudio/list-loaded"),

  /**
   * @param {{modelKey: string, contextLength?: number, ttlSec?: number, gpuOffload?: "max" | number}} args
   */
  load: (args) => http.post("/api/lmstudio/load", { json: args }),

  /** @param {string} identifier */
  unload: (identifier) => http.post("/api/lmstudio/unload", { json: { identifier } }),

  /**
   * @param {string} url
   * @returns {Promise<Record<string, unknown>>}
   */
  probeUrl: (url) => http.post("/api/lmstudio/probe-url", { json: { url } }),

  /* ─── Stubs (Phase 6 / Phase 2m) ─────────────────────────────── */

  autoConfigureModels: notImplemented("autoConfigureModels"),
  preloadAssignedModels: notImplemented("preloadAssignedModels"),
  actionsLog: async () => /** @type {Array<unknown>} */ ([]),
};
