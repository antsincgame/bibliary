import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
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

  return app;
}
