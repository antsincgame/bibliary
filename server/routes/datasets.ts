import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { buildDataset, downloadExport } from "../lib/datasets/build-bridge.js";
import {
  getExportJob,
  listExports,
  readJsonlHead,
} from "../lib/library/datasets.js";
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
        format: z.enum(["jsonl", "sharegpt"]).optional(),
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

  return app;
}
