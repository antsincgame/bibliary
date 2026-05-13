import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import {
  getServerStatus,
  listDownloaded,
  listLoaded,
  loadModel,
  probeUrl,
  unloadModel,
} from "../lib/llm/lmstudio-bridge.js";
import { requireAuth } from "../middleware/auth.js";

const ProbeBody = z.object({
  url: z.string().url().max(2048),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  ipv4Fallback: z.boolean().optional(),
});

const LoadBody = z.object({
  modelKey: z.string().min(1).max(500),
  opts: z
    .object({
      contextLength: z.number().int().positive().max(1_000_000).optional(),
      ttlSec: z.number().int().positive().max(86_400).optional(),
      gpuOffload: z.union([z.literal("max"), z.number().min(0).max(1)]).optional(),
    })
    .optional(),
});

export function lmstudioRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/status", async (c) => {
    const status = await getServerStatus();
    return c.json(status);
  });

  app.post("/probe-url", zValidator("json", ProbeBody), async (c) => {
    const body = c.req.valid("json");
    const probeOpts: { timeoutMs?: number; ipv4Fallback?: boolean } = {};
    if (body.timeoutMs !== undefined) probeOpts.timeoutMs = body.timeoutMs;
    if (body.ipv4Fallback !== undefined) probeOpts.ipv4Fallback = body.ipv4Fallback;
    const result = await probeUrl(body.url, probeOpts);
    return c.json(result);
  });

  app.get("/downloaded", async (c) => {
    try {
      const list = await listDownloaded();
      return c.json(list);
    } catch (err) {
      throw new HTTPException(503, {
        message: err instanceof Error ? err.message : "lmstudio_unreachable",
      });
    }
  });

  app.get("/loaded", async (c) => {
    try {
      const list = await listLoaded();
      return c.json(list);
    } catch (err) {
      throw new HTTPException(503, {
        message: err instanceof Error ? err.message : "lmstudio_unreachable",
      });
    }
  });

  app.post("/load", zValidator("json", LoadBody), async (c) => {
    const body = c.req.valid("json");
    try {
      const info = await loadModel(body.modelKey, body.opts ?? {});
      return c.json(info, 201);
    } catch (err) {
      throw new HTTPException(503, {
        message: err instanceof Error ? err.message : "load_failed",
      });
    }
  });

  app.delete("/loaded/:identifier", async (c) => {
    const identifier = c.req.param("identifier");
    try {
      await unloadModel(identifier);
      return c.json({ ok: true });
    } catch (err) {
      throw new HTTPException(503, {
        message: err instanceof Error ? err.message : "unload_failed",
      });
    }
  });

  return app;
}
