import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { deleteFromCollection } from "../lib/scanner/concepts.js";
import { probeOcrSupport } from "../lib/scanner/ocr.js";
import { requireAuth } from "../middleware/auth.js";

const DeleteFromCollectionBody = z.object({
  collection: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, "collection must be [a-zA-Z0-9_-]"),
  bookId: z.string().min(1).max(64),
});

export function scannerRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/ocr-support", (c) => {
    return c.json(probeOcrSupport());
  });

  app.post(
    "/delete-from-collection",
    zValidator("json", DeleteFromCollectionBody),
    (c) => {
      const user = c.get("user");
      if (!user) throw new HTTPException(401, { message: "auth_required" });
      const { collection, bookId } = c.req.valid("json");
      const result = deleteFromCollection(user.sub, collection, bookId);
      return c.json({ deleted: true, pointsDeleted: result.pointsDeleted });
    },
  );

  return app;
}
