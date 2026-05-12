import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { ID, Permission, Role } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { BUCKETS, getAppwrite, isAppwriteCode } from "../lib/appwrite.js";
import {
  queryByAuthor,
  queryByDomain,
  queryByTag,
  queryByYear,
  queryTagStats,
} from "../lib/library/aggregations.js";
import { writeAuditEvent } from "../lib/audit/log.js";
import { burnAllForUser } from "../lib/library/burn.js";
import { evaluateBookViaBridge } from "../lib/library/evaluator-bridge.js";
import { importFiles } from "../lib/library/import-pipeline.js";
import { getExtractionQueue } from "../lib/queue/extraction-queue.js";
import {
  getJob,
  listUserJobs,
} from "../lib/queue/job-store.js";
import { ALL_JOB_STATES } from "../lib/queue/types.js";
import { publishUser } from "../lib/realtime/event-bus.js";
import {
  deleteBook,
  getBookById,
  queryCatalog,
  type BookStatus,
} from "../lib/library/repository.js";
import { requireAuth } from "../middleware/auth.js";

const BookStatusEnum = z.enum([
  "imported",
  "layout-cleaning",
  "evaluating",
  "evaluated",
  "crystallizing",
  "indexed",
  "failed",
  "unsupported",
]) satisfies z.ZodType<BookStatus>;

const ListQuery = z.object({
  search: z.string().max(200).optional(),
  minQuality: z.coerce.number().min(0).max(10).optional(),
  maxQuality: z.coerce.number().min(0).max(10).optional(),
  hideFictionOrWater: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  domain: z.string().max(100).optional(),
  status: z.union([BookStatusEnum, z.array(BookStatusEnum)]).optional(),
  orderBy: z.enum(["quality", "title", "words", "evaluated"]).optional(),
  orderDir: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const DeleteQuery = z.object({
  deleteFiles: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

const LocaleQuery = z.object({
  locale: z.enum(["ru", "en"]).optional(),
});

async function streamFile(
  bucketId: string,
  fileId: string,
): Promise<{ body: Uint8Array<ArrayBuffer>; mime?: string }> {
  const { storage } = getAppwrite();
  const view = await storage.getFileDownload(bucketId, fileId);
  const ab = new ArrayBuffer(view.byteLength);
  new Uint8Array(ab).set(view instanceof Uint8Array ? view : new Uint8Array(view as ArrayBuffer));
  const body = new Uint8Array(ab);
  try {
    const meta = await storage.getFile(bucketId, fileId);
    return { body, mime: meta.mimeType ?? undefined };
  } catch {
    return { body };
  }
}

export function libraryRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/books", zValidator("query", ListQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const q = c.req.valid("query");
    const statuses = q.status
      ? Array.isArray(q.status)
        ? q.status
        : [q.status]
      : undefined;
    const queryArgs: Parameters<typeof queryCatalog>[1] = {};
    if (q.search !== undefined) queryArgs.search = q.search;
    if (q.minQuality !== undefined) queryArgs.minQuality = q.minQuality;
    if (q.maxQuality !== undefined) queryArgs.maxQuality = q.maxQuality;
    if (q.hideFictionOrWater !== undefined) queryArgs.hideFictionOrWater = q.hideFictionOrWater;
    if (statuses !== undefined) queryArgs.statuses = statuses;
    if (q.domain !== undefined) queryArgs.domain = q.domain;
    if (q.orderBy !== undefined) queryArgs.orderBy = q.orderBy;
    if (q.orderDir !== undefined) queryArgs.orderDir = q.orderDir;
    if (q.limit !== undefined) queryArgs.limit = q.limit;
    if (q.offset !== undefined) queryArgs.offset = q.offset;
    const result = await queryCatalog(user.sub, queryArgs);
    return c.json(result);
  });

  app.get("/books/:id", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const book = await getBookById(user.sub, c.req.param("id"));
    if (!book) throw new HTTPException(404, { message: "book_not_found" });
    return c.json(book);
  });

  app.get("/books/:id/markdown", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const book = await getBookById(user.sub, c.req.param("id"));
    if (!book) throw new HTTPException(404, { message: "book_not_found" });
    if (!book.markdownFileId) {
      throw new HTTPException(404, { message: "markdown_not_available" });
    }
    try {
      const { body } = await streamFile(BUCKETS.bookMarkdowns, book.markdownFileId);
      return c.body(body, 200, { "content-type": "text/markdown; charset=utf-8" });
    } catch (err) {
      if (isAppwriteCode(err, 404)) {
        throw new HTTPException(404, { message: "markdown_file_missing" });
      }
      throw err;
    }
  });

  app.get("/books/:id/cover", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const book = await getBookById(user.sub, c.req.param("id"));
    if (!book) throw new HTTPException(404, { message: "book_not_found" });
    if (!book.coverFileId) {
      throw new HTTPException(404, { message: "cover_not_available" });
    }
    try {
      const { body, mime } = await streamFile(BUCKETS.bookCovers, book.coverFileId);
      return c.body(body, 200, { "content-type": mime ?? "image/jpeg" });
    } catch (err) {
      if (isAppwriteCode(err, 404)) {
        throw new HTTPException(404, { message: "cover_file_missing" });
      }
      throw err;
    }
  });

  app.get("/books/:id/original", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const book = await getBookById(user.sub, c.req.param("id"));
    if (!book) throw new HTTPException(404, { message: "book_not_found" });
    if (!book.originalFileId) {
      throw new HTTPException(404, { message: "original_not_available" });
    }
    try {
      const { body, mime } = await streamFile(BUCKETS.bookOriginals, book.originalFileId);
      const filename = `${book.title.replace(/[^a-z0-9._-]/gi, "_")}.${book.originalExtension ?? "bin"}`;
      return c.body(body, 200, {
        "content-type": mime ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
      });
    } catch (err) {
      if (isAppwriteCode(err, 404)) {
        throw new HTTPException(404, { message: "original_file_missing" });
      }
      throw err;
    }
  });

  app.delete("/books/:id", zValidator("query", DeleteQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const q = c.req.valid("query");
    const book = await getBookById(user.sub, c.req.param("id"));
    if (!book) throw new HTTPException(404, { message: "book_not_found" });

    const removedFiles: string[] = [];
    if (q.deleteFiles) {
      const { storage } = getAppwrite();
      const drop = async (bucketId: string, fileId: string | null): Promise<void> => {
        if (!fileId) return;
        try {
          await storage.deleteFile(bucketId, fileId);
          removedFiles.push(`${bucketId}/${fileId}`);
        } catch (err) {
          if (!isAppwriteCode(err, 404)) throw err;
        }
      };
      await drop(BUCKETS.bookMarkdowns, book.markdownFileId);
      await drop(BUCKETS.bookOriginals, book.originalFileId);
      await drop(BUCKETS.bookCovers, book.coverFileId);
    }

    const ok = await deleteBook(user.sub, book.id);
    return c.json({ ok, removedFiles });
  });

  app.get("/tag-stats", zValidator("query", LocaleQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const { locale } = c.req.valid("query");
    const stats = await queryTagStats(user.sub, locale ?? "en");
    return c.json(stats);
  });

  app.get("/collection/by-domain", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    return c.json(await queryByDomain(user.sub));
  });

  app.get("/collection/by-author", zValidator("query", LocaleQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const { locale } = c.req.valid("query");
    return c.json(await queryByAuthor(user.sub, locale ?? "en"));
  });

  app.get("/collection/by-year", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    return c.json(await queryByYear(user.sub));
  });

  app.get("/collection/by-tag", zValidator("query", LocaleQuery), async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const { locale } = c.req.valid("query");
    return c.json(await queryByTag(user.sub, locale ?? "en"));
  });

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
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
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
   * subscribes to SSE channel `extractor_events:created` для прогресса,
   * либо poll'ит GET /api/library/jobs/:jobId.
   *
   * Если переданная книга не существует — extraction job создаётся
   * всё равно (queued), но worker запишет failed на первой итерации.
   * Это упрощает throughput (нет sync round-trip к Appwrite в hot path
   * POST handler'а).
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
   * Response is synchronous (no streaming) so the caller can subscribe
   * to SSE BEFORE any child job starts. SSE event `batch:filtered` is
   * published immediately after validation so the renderer can render
   * "27/30 eligible, starting" before the worker drains.
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
      /* job либо не существует, либо terminal (already done/failed/cancelled). */
      return c.json({ ok: false, reason: "job_not_cancellable" }, 409);
    }
    return c.json({ ok: true });
  });

  app.post(
    "/import-files",
    zValidator(
      "json",
      z.object({
        fileIds: z
          .array(z.string().min(1).max(64))
          .min(1)
          .max(200),
      }),
    ),
    async (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const { fileIds } = c.req.valid("json");
      const result = await importFiles(user.sub, fileIds);
      return c.json(result);
    },
  );

  /**
   * Browser drag&drop / file picker → multipart upload. Backend forwards
   * the file body to Appwrite Storage (`book-originals`) с per-user
   * permissions, возвращает `fileId` который renderer прокидывает в
   * POST /import-files для запуска парсера.
   *
   * Single-file per request чтобы избежать all-or-nothing semantics при
   * нескольких книгах в одном multipart payload — renderer вызывает
   * этот endpoint в цикле, ошибка одного файла не блокирует остальные.
   *
   * Bandwidth note: backend buffer'ит весь file body в RAM (Hono
   * parseBody возвращает File с full bytes). Для 5GB книги это
   * требует heap ≥ filesize. Оптимизация (direct browser→Appwrite
   * через Appwrite Account JWT) — отдельный коммит.
   */
  app.post("/upload", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });

    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: "file_field_required" });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = file.name || "upload.bin";

    const { storage } = getAppwrite();
    const stored = await storage.createFile(
      BUCKETS.bookOriginals,
      ID.unique(),
      InputFile.fromBuffer(buffer, fileName),
      [
        Permission.read(Role.user(user.sub)),
        Permission.update(Role.user(user.sub)),
        Permission.delete(Role.user(user.sub)),
        Permission.read(Role.team("admin")),
      ],
    );
    return c.json({
      fileId: stored.$id,
      name: fileName,
      size: buffer.byteLength,
    });
  });

  return app;
}
