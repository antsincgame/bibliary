import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppEnv } from "../app.js";
import {
  deleteCollection,
  getCollectionInfo,
  heartbeat,
  listCollections,
} from "../lib/vectordb/store.js";
import { requireAuth } from "../middleware/auth.js";

export function vectordbRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/collections", (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });
    const list = listCollections(user.sub);
    return c.json(list);
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

  return app;
}
