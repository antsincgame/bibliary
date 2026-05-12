import { http } from "./http.js";

/**
 * Vector database is sqlite-vec on backend. Per-user partitioning lives
 * in server/lib/vectordb/store.ts (WHERE user_id = ?).
 *
 * Legacy renderer used both `vectordb.*` (typed) and the flat
 * `getCollections()` helper — оба сохранены для совместимости.
 */

const list = () => http.get("/api/vectordb/collections");

export const getCollections = async () =>
  (await list()).map((c) => /** @type {{name: string}} */ (c).name);

export const vectordb = {
  /**
   * @returns {Promise<Array<{name: string, pointsCount: number}>>}
   */
  listDetailed: () => http.get("/api/vectordb/collections"),

  /** @param {string} name */
  info: (name) =>
    http.get(`/api/vectordb/collections/${encodeURIComponent(name)}`).catch((err) => {
      if (err && /** @type {any} */ (err).status === 404) return null;
      throw err;
    }),

  /**
   * @param {{name: string, distance?: "cosine" | "l2" | "ip" | "dot"}} args
   * @returns {Promise<{ok: true, name: string, exists: boolean}>}
   */
  create: (args) => http.post("/api/vectordb/collections", { json: args }),

  /** @param {string} name */
  remove: (name) =>
    http.delete(`/api/vectordb/collections/${encodeURIComponent(name)}`),

  /**
   * @returns {Promise<{online: boolean, url: string, version: string, collectionsCount: number, latencyMs?: number, message?: string}>}
   */
  heartbeat: () => http.get("/api/vectordb/heartbeat"),
};
