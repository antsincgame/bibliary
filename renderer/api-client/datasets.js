import { http } from "./http.js";

/**
 * Datasets surface — на web метаданные живут в Appwrite `dataset_jobs`
 * collection (server/lib/library/datasets.ts), а JSONL файлы в bucket
 * `dataset-exports`. Legacy `readMeta(dirPath)` / `readJsonlHead({filePath})`
 * сохранены по API surface; аргумент превращается в jobId, file path —
 * exportFileId дёргается из job-document.
 */

const notImplemented = (name) => async () => {
  throw new Error(`datasets.${name} not yet implemented in web mode`);
};

export const datasets = {
  /**
   * @returns {Promise<{rows: any[], total: number}>}
   */
  listExports: (opts) =>
    http.get("/api/datasets/exports", opts ? { query: opts } : undefined),

  /**
   * Legacy `readMeta(dirPath)` shape: возвращает `{ok, meta, files, outputDir}`.
   * Web-mode: принимает jobId (renderer уже видит jobId через listExports).
   * Маппинг полей dataset_jobs document → legacy shape:
   *   meta.sourceCollection = targetCollection
   *   meta.format = "sharegpt" (default — UI прежде использовал)
   *   meta.method = extractModel ? "llm-synth" : "template"
   *
   * @param {string} jobIdOrLegacyPath
   */
  async readMeta(jobIdOrLegacyPath) {
    if (typeof jobIdOrLegacyPath !== "string" || !jobIdOrLegacyPath) {
      return { ok: false, error: "missing job id" };
    }
    try {
      const job = await http.get(
        `/api/datasets/exports/${encodeURIComponent(jobIdOrLegacyPath)}`,
      );
      return {
        ok: true,
        outputDir: /** @type {any} */ (job).id,
        meta: {
          sourceCollection: /** @type {any} */ (job).targetCollection,
          format: "sharegpt",
          method: /** @type {any} */ (job).extractModel ? "llm-synth" : "template",
          model: /** @type {any} */ (job).extractModel,
          concepts: /** @type {any} */ (job).conceptsExtracted,
          totalLines: 0,
          trainLines: 0,
          valLines: 0,
          generatedAt: /** @type {any} */ (job).createdAt,
        },
        files: [],
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /**
   * @param {{filePath: string, limit?: number}} args
   */
  async readJsonlHead(args) {
    const { filePath, limit = 50 } = args || /** @type {any} */ ({});
    if (!filePath) return { ok: false, error: "missing filePath" };
    try {
      const data = await http.get(
        `/api/datasets/exports/${encodeURIComponent(filePath)}/head`,
        { query: { limit } },
      );
      return { ok: true, lines: /** @type {any} */ (data).lines };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /**
   * Phase 8a — build dataset from accepted concepts. Sync execution
   * (5-30s для 100-1000 concepts). Returns {jobId, exportFileId,
   * lineCount, bytes} на success или {error, jobId} на fail.
   *
   * После success caller вызывает downloadUrl(jobId) или idёт на
   * GET /api/datasets/exports/:jobId/download напрямую (browser саvе-as).
   *
   * @param {{collection: string, format?: "jsonl"}} args
   * @returns {Promise<{ok: boolean, jobId: string, exportFileId?: string, lineCount?: number, bytes?: number, warnings?: string[], error?: string}>}
   */
  build: (args) => http.post("/api/datasets/build", { json: args }),

  /**
   * Build a same-origin URL for downloading the generated file.
   * Browser auto-saves with content-disposition set by backend.
   * @param {string} jobId
   * @returns {string}
   */
  downloadUrl: (jobId) =>
    `/api/datasets/exports/${encodeURIComponent(jobId)}/download`,

  /* Electron native folder picker — недоступен в web. */
  pickFolder: notImplemented("pickFolder"),
};
