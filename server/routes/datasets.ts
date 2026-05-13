import { Query } from "node-appwrite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { COLLECTIONS, getAppwrite, type RawDoc } from "../lib/appwrite.js";
import { downloadExport } from "../lib/datasets/build-bridge.js";
import { embedQuery } from "../lib/embedder/index.js";
import {
  getExportJob,
  listExports,
  readJsonlHead,
} from "../lib/library/datasets.js";
import { getExportQueue } from "../lib/queue/export-queue.js";
import { findSimilarChunks } from "../lib/vectordb/chunks.js";
import { findSimilarConcepts } from "../lib/vectordb/concepts.js";
import {
  findEntityIdsForQuery,
  personalizedPageRank,
  scoreChunksByGraph,
} from "../lib/vectordb/ppr.js";
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
   * Phase 8b — dataset build enqueue. Creates a `dataset_jobs` doc
   * (state=queued, stage=`build:<format>`) and hands the jobId back
   * immediately as HTTP 202. The export-queue worker drains in the
   * background; the client polls GET /exports/:jobId or subscribes
   * to `extractor_events:created` SSE.
   *
   * Pre-8b this endpoint blocked the request thread for the entire
   * build (potentially minutes for ShareGPT on a large collection),
   * which timed out browsers and proxies before the upload finished.
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
      const job = await getExportQueue().enqueue({
        userId: user.sub,
        collection: body.collection,
        format: body.format ?? "jsonl",
      });
      return c.json(
        {
          ok: true,
          jobId: job.id,
          state: job.state,
          stage: job.stage,
          collection: body.collection,
          format: body.format ?? "jsonl",
        },
        202,
      );
    },
  );

  /**
   * Cancel a queued or running export build. State machine:
   *   - queued  → cancelled (worker pickup will skip)
   *   - running → AbortSignal fired + cancelled transition (build
   *               returns cancelled: true before upload)
   *   - terminal → 409 (already finished or cancelled)
   *
   * Mirrors the extraction queue cancel route at /books/:id/cancel.
   */
  app.post("/exports/:jobId/cancel", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const jobId = c.req.param("jobId");
    const ok = await getExportQueue().cancel(user.sub, jobId);
    if (!ok) {
      throw new HTTPException(409, { message: "cannot_cancel_in_current_state" });
    }
    return c.json({ ok: true, jobId });
  });

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

  /**
   * Phase Δf — chunk-level graph-aware retrieval. Combines:
   *   α · cosine(L1 chunk embedding, query)
   *   β · graph score = sum of PPR(entity) for entities the chunk
   *       produced relations on; PPR is seeded from query tokens
   *       matching entities.
   *
   * Returns chunks ordered by the blended final score. Use cases:
   *   - "Find passages mentioning X" where X may be referenced via
   *     anaphora the cosine layer would miss.
   *   - Multi-hop bridging: query for entity A returns chunks that
   *     produce relations on B, where A→B is a graph edge.
   *
   * Defaults: α=0.7, β=0.3. Caller can override via query string for
   * experimentation. Setting β=0 reduces to pure cosine search over
   * chunks (useful baseline).
   */
  app.get(
    "/search-chunks",
    zValidator(
      "query",
      z.object({
        q: z.string().min(2).max(500),
        limit: z.coerce.number().int().positive().max(50).default(10),
        alpha: z.coerce.number().min(0).max(1).default(0.7).optional(),
        beta: z.coerce.number().min(0).max(1).default(0.3).optional(),
        bookId: z.string().min(1).max(100).optional(),
        minSimilarity: z.coerce.number().min(0).max(1).default(0).optional(),
      }),
    ),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const { q, limit, alpha, beta, bookId, minSimilarity } = c.req.valid("query");
      const α = alpha ?? 0.7;
      const β = beta ?? 0.3;

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

      /* Wide cosine pull — we re-rank, so over-fetch by 5x the final
       * limit (capped at 100) so the graph re-ranker has room to
       * shuffle results past the naive top-K cutoff. */
      const cosineLimit = Math.min(100, Math.max(limit * 5, limit));
      const cosineOpts: Parameters<typeof findSimilarChunks>[0] = {
        userId: user.sub,
        embedding: queryVec,
        limit: cosineLimit,
        level: 1,
      };
      if (bookId) cosineOpts.bookId = bookId;
      if (minSimilarity !== undefined) cosineOpts.minSimilarity = minSimilarity;
      const cosineHits = findSimilarChunks(cosineOpts);
      if (cosineHits.length === 0) {
        return c.json({ rows: [], total: 0, alpha: α, beta: β });
      }

      /* Build PPR scores if β > 0 and the query seeded entities. */
      let graphScores = new Map<number, number>();
      let pprSeeds = 0;
      let pprIterations = 0;
      if (β > 0) {
        const seedIds = findEntityIdsForQuery(user.sub, q);
        pprSeeds = seedIds.length;
        if (seedIds.length > 0) {
          const ppr = personalizedPageRank({
            userId: user.sub,
            seeds: seedIds.map((id) => ({ entityId: id, weight: 1 })),
          });
          pprIterations = ppr.iterations;
          graphScores = scoreChunksByGraph({
            userId: user.sub,
            chunkRowIds: cosineHits.map((h) => h.vecRowid),
            pprScores: ppr.scores,
          });
        }
      }

      /* Normalize graph scores so the blend is on comparable scale.
       * cosine ∈ [0,1] already; graph is unbounded sum-of-PPR. */
      let maxGraph = 0;
      for (const s of graphScores.values()) if (s > maxGraph) maxGraph = s;
      const normGraph = (rowid: number): number => {
        if (maxGraph === 0) return 0;
        return (graphScores.get(rowid) ?? 0) / maxGraph;
      };

      const ranked = cosineHits
        .map((h) => {
          const cos = h.similarity;
          const g = normGraph(h.vecRowid);
          const finalScore = α * cos + β * g;
          return {
            chunkRowid: h.vecRowid,
            bookId: h.bookId,
            similarity: cos,
            graphScore: g,
            finalScore,
            level: h.level,
            pathTitles: h.pathTitles,
            partN: h.partN,
            partOf: h.partOf,
            text: h.text,
          };
        })
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, limit);

      return c.json({
        rows: ranked,
        total: ranked.length,
        alpha: α,
        beta: β,
        pprSeeds,
        pprIterations,
      });
    },
  );

  return app;
}
