import { http } from "./http.js";

/**
 * Preferences are stored as a single JSON blob per user in Appwrite's
 * `user_preferences` collection (server-side `server/lib/preferences/store.ts`).
 * Renderer reads/writes via GET/PATCH /api/preferences.
 *
 * onChanged push events будут проходить через Appwrite Realtime
 * (Phase 3b adapter) — пока в этой реализации stub (никогда не вызывает
 * callback). Renderer должен переживать отсутствие push'а (большинство
 * мест перечитывают prefs на действие).
 */

/** @typedef {Record<string, unknown>} Preferences */

export const preferences = {
  /** @returns {Promise<Preferences>} */
  getAll: () => http.get("/api/preferences"),

  /** @returns {Promise<Preferences>} */
  getDefaults: () => http.get("/api/preferences/defaults"),

  /**
   * @param {Partial<Preferences>} patch
   * @returns {Promise<Preferences>}
   */
  set: (patch) => http.patch("/api/preferences", { json: patch }),

  /** @returns {Promise<Preferences>} */
  reset: () => http.post("/api/preferences/reset"),

  /**
   * Subscribe to changes. In web-mode events come via Appwrite Realtime
   * (Phase 3b) — until then this is a no-op subscriber that never fires.
   * Returns an unsubscribe function for API symmetry.
   *
   * @param {(prefs: Preferences) => void} _cb
   * @returns {() => void}
   */
  onChanged: (_cb) => () => undefined,
};
