import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import type { AppEnv } from "../app.js";

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) {
    throw new HTTPException(401, { message: "auth_required" });
  }
  if (user.role !== "admin") {
    throw new HTTPException(403, { message: "admin_required" });
  }
  await next();
});
