import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { ID, Permission, Role } from "../lib/store/query.js";
import { InputFile } from "../lib/store/input-file.js";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { loadConfig } from "../config.js";
import { BUCKETS, getDatastore } from "../lib/datastore.js";
import { importFiles } from "../lib/library/import-pipeline.js";

/**
 * Phase Round-3 library god-object split. Ingestion side — file
 * upload to Appwrite Storage + the trigger that converts uploaded
 * blobs into catalog rows.
 *
 * Endpoints:
 *   POST /upload         multipart upload → book-originals bucket
 *   POST /import-files   convert fileIds → markdown + catalog rows
 */

export function registerIngestionRoutes(app: Hono<AppEnv>): void {
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
   * the file body to Appwrite Storage (`book-originals`) with per-user
   * permissions, returns `fileId` which the renderer passes to
   * POST /import-files to kick off the parser.
   *
   * Single file per request to avoid all-or-nothing semantics with
   * multi-file multipart payloads — the renderer loops, one failure
   * doesn't block the others.
   *
   * Bandwidth note: backend buffers the entire file body in RAM (Hono
   * parseBody returns File with full bytes). For a 5 GB book that
   * needs heap ≥ filesize. Optimization (direct browser→Appwrite via
   * Appwrite Account JWT) is a separate commit.
   */
  app.post("/upload", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });

    const cfg = loadConfig();
    /* Hono parseBody buffers the whole multipart body in RAM — without
     * a size cap a single rogue upload OOMs the pod. Default 200 MB
     * via BIBLIARY_UPLOAD_MAX_BYTES; tune up in .env for giant scanned
     * PDF corpora. Content-Length is set by browsers; we double-check
     * the actual buffered size below in case of chunked encoding. */
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > cfg.BIBLIARY_UPLOAD_MAX_BYTES) {
      throw new HTTPException(413, { message: "upload_too_large" });
    }

    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: "file_field_required" });
    }
    if (file.size === 0) {
      throw new HTTPException(400, { message: "upload_empty" });
    }
    if (file.size > cfg.BIBLIARY_UPLOAD_MAX_BYTES) {
      throw new HTTPException(413, { message: "upload_too_large" });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = file.name || "upload.bin";

    const { storage } = getDatastore();
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
}
