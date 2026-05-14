import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import {
  deleteCollection,
  getCollectionInfo,
  heartbeat,
  listCollections,
} from "../lib/vectordb/store.js";
import { getBookGraph } from "../lib/vectordb/graph.js";
import { requireAuth } from "../middleware/auth.js";

const CreateCollectionBody = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, "name must be [a-zA-Z0-9_-]"),
  /**
   * Distance metric. sqlite-vec uses cosine by default on the shared
   * concepts_vec virtual table — per-collection distance isn't possible
   * because all user collections share the same vec0 schema. Field is
   * accepted for renderer API compatibility but ignored at storage level.
   */
  distance: z.enum(["cosine", "l2", "ip", "dot"]).optional(),
});

export function vectordbRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/collections", (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const list = listCollections(user.sub);
    return c.json(list);
  });

  app.post("/collections", zValidator("json", CreateCollectionBody), (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const { name } = c.req.valid("json");
    /**
     * sqlite-vec collections are implicit — created on first insert. We
     * report the existence state so renderer can decide whether to surface
     * "created" or "already exists" feedback, matching legacy LanceDB API.
     */
    const existed = getCollectionInfo(user.sub, name) !== null;
    return c.json({ ok: true, name, exists: existed });
  });

  app.get("/collections/:name", (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const info = getCollectionInfo(user.sub, c.req.param("name"));
    if (!info) {
      throw new HTTPException(404, { message: "collection_not_found" });
    }
    return c.json(info);
  });

  app.delete("/collections/:name", (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const result = deleteCollection(user.sub, c.req.param("name"));
    return c.json({ ok: true, deleted: result.deleted });
  });

  app.get("/heartbeat", (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    return c.json(heartbeat(user.sub));
  });

  /* Knowledge graph for one book — entities (nodes) + relations (edges)
   * the crystallizer extracted. Shaped for the renderer's graph view. */
  app.get("/graph/book/:bookId", (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    return c.json(getBookGraph(user.sub, c.req.param("bookId")));
  });

  return app;
}
