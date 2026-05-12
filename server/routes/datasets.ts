import { Query } from "node-appwrite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { COLLECTIONS, getAppwrite, type RawDoc } from "../lib/appwrite.js";
import { buildDataset, downloadExport } from "../lib/datasets/build-bridge.js";
import { embedQuery } from "../lib/embedder/index.js";
import {
  getExportJob,
  listExports,
  readJsonlHead,
} from "../lib/library/datasets.js";
import { findSimilarConcepts } from "../lib/vectordb/concepts.js";
import { requireAuth } from "../middleware/auth.js";

const ListQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  completedOnly: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

const HeadQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export function datasetsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/exports", zValidator("query", ListQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const q = c.req.valid("query");
    const opts: Parameters<typeof listExports>[1] = {};
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.offset !== undefined) opts.offset = q.offset;
    if (q.completedOnly !== undefined) opts.completedOnly = q.completedOnly;
    const result = await listExports(user.sub, opts);
    return c.json(result);
  });

  app.get("/exports/:jobId", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const job = await getExportJob(user.sub, c.req.param("jobId"));
    if (!job) throw new HTTPException(404, { message: "export_not_found" });
    return c.json(job);
  });

  app.get("/exports/:jobId/head", zValidator("query", HeadQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const job = await getExportJob(user.sub, c.req.param("jobId"));
    if (!job) throw new HTTPException(404, { message: "export_not_found" });
    if (!job.exportFileId) {
      throw new HTTPException(404, { message: "export_file_not_ready" });
    }
    const { limit } = c.req.valid("query");
    const result = await readJsonlHead(user.sub, job.exportFileId, limit);
    if (!result) throw new HTTPException(404, { message: "export_file_missing" });
    return c.json(result);
  });

  /**
   * Phase 8a — dataset build. Synthesizes accepted concepts из
   * collection в JSONL → uploads в `dataset-exports` bucket → returns
   * jobId. Phase 8b добавит ShareGPT / ChatML formats.
   */
  app.post(
    "/build",
    zValidator(
      "json",
      z.object({
        collection: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9_-]+$/, "collection must be [a-zA-Z0-9_-]"),
        format: z.enum(["jsonl", "sharegpt", "chatml"]).optional(),
      }),
    ),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const body = c.req.valid("json");
      const result = await buildDataset({
        userId: user.sub,
        collectionName: body.collection,
        format: body.format ?? "jsonl",
      });
      if (!result.ok) {
        const status = result.error === "no_concepts_in_collection" ? 409 : 502;
        return c.json(result, status);
      }
      return c.json(result, 201);
    },
  );

  /**
   * Download generated export. Returns 404 если job not found / not
   * owned / not yet completed. Sets Content-Disposition: attachment
   * чтобы browser сразу saved-as.
   */
  app.get("/exports/:jobId/download", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const result = await downloadExport(user.sub, c.req.param("jobId"));
    if (!result) throw new HTTPException(404, { message: "export_not_found" });
    return c.body(result.body, 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "content-length": String(result.size),
    });
  });

  /**
   * Phase 10d — semantic search over user's concept embeddings.
   * Query text → embedQuery → sqlite-vec KNN → fetch Appwrite docs
   * → return ranked results with delta payload + cosine similarity.
   *
   * Use cases:
   *   - "Find concepts about FEM convergence" → returns top-10
   *     с relevance scores.
   *   - Pre-build dataset preview ("какие концепты войдут в датасет
   *     X").
   *   - User exploration: «что я знаю про topic Y из своих книг».
   */
  app.get(
    "/search",
    zValidator(
      "query",
      z.object({
        q: z.string().min(2).max(500),
        collection: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9_-]+$/, "collection must be [a-zA-Z0-9_-]"),
        limit: z.coerce.number().int().positive().max(50).default(10),
        minSimilarity: z.coerce.number().min(0).max(1).default(0).optional(),
      }),
    ),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const { q, collection, limit, minSimilarity } = c.req.valid("query");

      let queryVec: Float32Array;
      try {
        queryVec = await embedQuery(q);
      } catch (err) {
        throw new HTTPException(503, {
          message:
            err instanceof Error
              ? `embedder_unavailable: ${err.message}`
              : "embedder_unavailable",
        });
      }

      const opts: Parameters<typeof findSimilarConcepts>[0] = {
        userId: user.sub,
        collectionName: collection,
        embedding: queryVec,
        limit,
      };
      if (minSimilarity !== undefined) opts.minSimilarity = minSimilarity;
      const similar = findSimilarConcepts(opts);

      if (similar.length === 0) {
        return c.json({ rows: [], total: 0 });
      }

      /* Fetch Appwrite concept documents для top-K rowid. Один listDocuments
       * with $in filter — Appwrite supports Query.equal с array value. */
      const { databases, databaseId } = getAppwrite();
      const rowIds = similar.map((s) => s.rowid);
      const docs = await databases.listDocuments<
        RawDoc & {
          userId: string;
          bookId: string;
          collectionName: string;
          payload: string;
          vectorRowId: number;
        }
      >(databaseId, COLLECTIONS.concepts, [
        Query.equal("userId", user.sub),
        Query.equal("collectionName", collection),
        Query.equal("vectorRowId", rowIds),
        Query.limit(limit),
      ]);

      /* Sort docs in the same order как sqlite-vec returned (best similarity first). */
      const byRowId = new Map(docs.documents.map((d) => [d.vectorRowId, d]));
      const rows = similar
        .map((s) => {
          const doc = byRowId.get(s.rowid);
          if (!doc) return null;
          let delta: unknown = null;
          try {
            delta = JSON.parse(doc.payload);
          } catch {
            delta = null;
          }
          return {
            conceptId: doc.$id,
            bookId: doc.bookId,
            similarity: s.similarity,
            delta,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      return c.json({ rows, total: rows.length });
    },
  );

  return app;
}
