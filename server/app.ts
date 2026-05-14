import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";

import { getCorsOrigins, loadConfig } from "./config.js";
import { isDomainError } from "./lib/errors.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { datasetsRoutes } from "./routes/datasets.js";
import { eventsRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { libraryRoutes } from "./routes/library.js";
import { llmRoutes } from "./routes/llm.js";
import { lmstudioRoutes } from "./routes/lmstudio.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { scannerRoutes } from "./routes/scanner.js";
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

  /**
   * Strict CSP in production; in development we allow 'unsafe-inline' +
   * 'unsafe-eval' for Vite HMR (its runtime injection needs them).
   * Renderer + backend are served same-origin in production, so 'self'
   * covers everything — there is no external data backend to allow.
   *
   * Frame-ancestors 'none' guards against clickjacking; X-Frame-Options
   * is added by secureHeaders by default.
   */
  const isProd = cfg.NODE_ENV === "production";
  const scriptSrc: string[] = isProd ? ["'self'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"];
  const styleSrc: string[] = ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"];
  const connectSrc: string[] = ["'self'"];

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc,
        styleSrc,
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc,
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: "same-origin-allow-popups",
      crossOriginResourcePolicy: "same-site",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );

  /**
   * Auth-flow rate limit: 20 req/min per-IP. Покрывает login + register +
   * refresh + password change. Защищает от credential-stuffing и
   * брутфорса refresh tokens. Authenticated routes лимитируются на
   * application layer (Phase 7 workers).
   */
  app.use("/api/auth/*", rateLimit("auth", 20, 60_000));

  /**
   * Upload rate limit: 50 файлов в 10 минут на IP. Multipart upload —
   * самый дорогой endpoint (filesize bytes + parser CPU); brute через
   * него самый эффективный DoS vector.
   */
  app.use("/api/library/upload", rateLimit("upload", 50, 10 * 60_000));

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
  app.route("/api/admin", adminRoutes());
  app.route("/api/preferences", preferencesRoutes());
  app.route("/api/system", systemRoutes());
  app.route("/api/lmstudio", lmstudioRoutes());
  app.route("/api/llm", llmRoutes());
  app.route("/api/vectordb", vectordbRoutes());
  app.route("/api/scanner", scannerRoutes());
  app.route("/api/library", libraryRoutes());
  app.route("/api/datasets", datasetsRoutes());
  app.route("/api/events", eventsRoutes());

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    /* DomainError carries a stable code + intended HTTP status; let
     * lib/* code throw it without importing hono. The contract here is
     * the only place that translates it. */
    if (isDomainError(err)) {
      const body: Record<string, unknown> = { error: err.code };
      if (err.details) body["details"] = err.details;
      return c.json(body, err.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
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
