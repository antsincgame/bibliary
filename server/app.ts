import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";

import { getCorsOrigins, loadConfig } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { lmstudioRoutes } from "./routes/lmstudio.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { systemRoutes } from "./routes/system.js";
import { vectordbRoutes } from "./routes/vectordb.js";

export type AppEnv = {
  Variables: {
    user?: { sub: string; role: "user" | "admin"; email: string };
    requestId: string;
  };
};

export function buildApp(): Hono<AppEnv> {
  const cfg = loadConfig();
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId =
      c.req.header("x-request-id") ?? globalThis.crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  app.use("*", logger());
  app.use("*", secureHeaders());

  const allowedOrigins = getCorsOrigins(cfg);
  app.use(
    "*",
    cors({
      origin: (origin) =>
        origin && allowedOrigins.includes(origin) ? origin : null,
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
    }),
  );

  app.route("/", healthRoutes());
  app.route("/api/auth", authRoutes());
  app.route("/api/preferences", preferencesRoutes());
  app.route("/api/system", systemRoutes());
  app.route("/api/lmstudio", lmstudioRoutes());
  app.route("/api/vectordb", vectordbRoutes());

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    console.error("[app] unhandled error:", err);
    return c.json(
      { error: "internal_error", message: "Internal server error" },
      500,
    );
  });

  app.notFound((c) =>
    c.json({ error: "not_found", message: `${c.req.method} ${c.req.path}` }, 404),
  );

  return app;
}
