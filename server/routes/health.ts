import { Hono } from "hono";

import type { AppEnv } from "../app.js";
import { getVersionInfo } from "../lib/version.js";

export function healthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => {
    const v = getVersionInfo();
    return c.json({
      ok: true,
      version: v.version,
      commit: v.commit,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
