import { http } from "./http.js";

/**
 * Scanner — на web ограничен read-only методами (ocr-support) и
 * управлением vectordb (delete-from-collection). Полный ingest flow
 * (probe-files, parse-preview, start-ingest, cancel-ingest) идёт через
 * /api/library/import-files после upload в Appwrite Storage SDK (Phase 4).
 */

export const scanner = {
  /** @returns {Promise<{supported: boolean, platform: string, reason?: string}>} */
  ocrSupport: () => http.get("/api/scanner/ocr-support"),

  /**
   * @param {string} bookSourcePath  legacy positional arg — ignored on web (был для SQLite-id)
   * @param {string} collection
   * @param {string} bookId
   */
  deleteFromCollection: (bookSourcePath, collection, bookId) =>
    http.post("/api/scanner/delete-from-collection", {
      json: { collection, bookId },
    }),
};
