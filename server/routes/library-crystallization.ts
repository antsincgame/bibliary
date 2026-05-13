import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { writeAuditEvent } from "../lib/audit/log.js";
import { burnAllForUser } from "../lib/library/burn.js";
import { evaluateBookViaBridge } from "../lib/library/evaluator-bridge.js";
import { getExtractionQueue } from "../lib/queue/extraction-queue.js";
import {
  getJob,
  listAllJobs,
  listUserJobs,
} from "../lib/queue/job-store.js";
import { ALL_JOB_STATES } from "../lib/queue/types.js";
import { publishUser } from "../lib/realtime/event-bus.js";
import { getBookById } from "../lib/library/repository.js";

/**
 * Phase Round-3 library god-object split. Knowledge-creation side:
 * evaluate, extract single, extract batch, job control surface,
 * burn-all destructive purge.
 *
 * Endpoints:
 *   POST   /burn-all                    self-purge entire library (audited)
 *   POST   /books/:id/evaluate          quality scoring via evaluator role
 *   POST   /books/:id/extract           enqueue single-book crystallization
 *   POST   /batches/start               quality-gated batch crystallization
 *   GET    /jobs                        per-user job list
 *   GET    /jobs/:jobId                 single job inspection
 *   POST   /jobs/:jobId/cancel          per-user job cancel
 */

export function registerCrystallizationRoutes(app: Hono<AppEnv>): void {
  app.post("/burn-all", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const result = await burnAllForUser(user.sub);
    /* Phase 11c — burn-all is the most destructive user-facing action;
     * always audit it. The acting user IS the target (self-burn). */
    void writeAuditEvent({
      userId: user.sub,
      action: "library.burn_all",
      target: user.sub,
      metadata: {
        booksDeleted: result.booksDeleted,
        conceptsDeleted: result.conceptsDeleted,
        chunksDeleted: result.chunksDeleted,
        vectorRowsDeleted: result.vectorRowsDeleted,
        storageFilesRemoved: result.storageFilesRemoved,
      },
      ip:
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        c.req.header("x-real-ip") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });
    return c.json(result);
  });

  app.post("/books/:id/evaluate", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const bookId = c.req.param("id");
    const result = await evaluateBookViaBridge(user.sub, bookId);
    if (!result.ok) {
      const status =
        result.error === "book_not_found"
          ? 404
          : result.error === "markdown_not_available" || result.error === "markdown_file_missing"
            ? 409
            : 502;
      return c.json(result, status);
    }
    return c.json(result);
  });

  /**
   * Phase 7a/7b: async extract. Endpoint enqueues a dataset_jobs
   * document, returns jobId immediately (HTTP 202 Accepted). Caller
   * subscribes to SSE channel `extractor_events:created` for progress,
   * or polls GET /api/library/jobs/:jobId.
   *
   * If the book doesn't exist the job still gets created (queued),
   * but the worker will record `failed` on first iteration. Simpler
   * throughput (no sync round-trip in hot path).
   */
  app.post(
    "/books/:id/extract",
    zValidator(
      "json",
      z
        .object({
          collection: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[a-zA-Z0-9_-]+$/, "collection must be [a-zA-Z0-9_-]")
            .optional(),
        })
        .optional(),
    ),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const bookId = c.req.param("id");
      const body = (c.req.valid("json") ?? {}) as { collection?: string };
      const queue = getExtractionQueue();
      const job = await queue.enqueue({
        userId: user.sub,
        bookId,
        ...(body.collection ? { collection: body.collection } : {}),
      });
      return c.json({ ok: true, jobId: job.id, state: job.state }, 202);
    },
  );

  /**
   * Phase 9 — batch crystallization. Enqueues N child jobs (one per
   * eligible book) into the existing extraction queue with a shared
   * target collection. The "batch" itself is an opaque, ephemeral
   * grouping — its progress is aggregated by the client from the SSE
   * channel using the returned jobId list.
   *
   * Quality gate (server-enforced):
   *   - book.qualityScore must be set (evaluated) AND >= minQuality
   *   - book.isFictionOrWater must NOT be true
   *   - book.markdownFileId must be set
   * Books failing any check appear in `skipped` with a reason; nothing
   * else is enqueued for them.
   *
   * Response is synchronous so the caller can subscribe to SSE BEFORE
   * any child job starts. SSE event `batch:filtered` published
   * immediately after validation lets the renderer show "27/30
   * eligible, starting" before the worker drains.
   */
  app.post(
    "/batches/start",
    zValidator(
      "json",
      z.object({
        bookIds: z.array(z.string().min(1).max(100)).min(1).max(500),
        collection: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9_-]+$/, "collection must be [a-zA-Z0-9_-]"),
        minQuality: z.coerce.number().min(0).max(10).default(5).optional(),
      }),
    ),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const body = c.req.valid("json");
      const minQuality = body.minQuality ?? 5;
      const batchId = randomUUID();
      const enqueued: Array<{ bookId: string; jobId: string }> = [];
      const skipped: Array<{
        bookId: string;
        reason:
          | "not_found"
          | "missing_markdown"
          | "fiction_or_water"
          | "unevaluated"
          | "low_quality";
      }> = [];

      for (const bookId of body.bookIds) {
        const book = await getBookById(user.sub, bookId);
        if (!book) {
          skipped.push({ bookId, reason: "not_found" });
          continue;
        }
        if (!book.markdownFileId) {
          skipped.push({ bookId, reason: "missing_markdown" });
          continue;
        }
        if (book.isFictionOrWater === true) {
          skipped.push({ bookId, reason: "fiction_or_water" });
          continue;
        }
        if (typeof book.qualityScore !== "number") {
          skipped.push({ bookId, reason: "unevaluated" });
          continue;
        }
        if (book.qualityScore < minQuality) {
          skipped.push({ bookId, reason: "low_quality" });
          continue;
        }
        const queue = getExtractionQueue();
        const job = await queue.enqueue({
          userId: user.sub,
          bookId,
          collection: body.collection,
        });
        enqueued.push({ bookId, jobId: job.id });
      }

      publishUser(user.sub, "extractor_events:created", {
        batchId,
        event: "batch:filtered",
        payload: {
          kind: "batch",
          collection: body.collection,
          total: body.bookIds.length,
          eligible: enqueued.length,
          skipped: skipped.length,
          minQuality,
        },
      });

      return c.json(
        {
          batchId,
          enqueued,
          skipped,
          total: body.bookIds.length,
          eligible: enqueued.length,
        },
        201,
      );
    },
  );

  /* ─── Job control surface (Phase 7b) ────────────────────────────── */

  const ListJobsQuery = z.object({
    state: z.enum(ALL_JOB_STATES).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  });

  app.get("/jobs", zValidator("query", ListJobsQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const q = c.req.valid("query");
    const opts: Parameters<typeof listUserJobs>[1] = {};
    if (q.state) opts.state = q.state;
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.offset !== undefined) opts.offset = q.offset;
    const result = await listUserJobs(user.sub, opts);
    return c.json(result);
  });

  app.get("/jobs/:jobId", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const job = await getJob(user.sub, c.req.param("jobId"));
    if (!job) throw new HTTPException(404, { message: "job_not_found" });
    return c.json(job);
  });

  app.post("/jobs/:jobId/cancel", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const queue = getExtractionQueue();
    const ok = await queue.cancel(user.sub, c.req.param("jobId"));
    if (!ok) {
      /* Job either doesn't exist or is terminal (already done/failed/cancelled). */
      return c.json({ ok: false, reason: "job_not_cancellable" }, 409);
    }
    return c.json({ ok: true });
  });

  /* Keep listAllJobs reachable from this module so the admin route
   * doesn't have to re-derive it; this avoids a phantom unused import. */
  void listAllJobs;
}
