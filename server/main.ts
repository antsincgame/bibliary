import { serve } from "@hono/node-server";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startExtractionWorker } from "./lib/queue/extraction-queue.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = buildApp();

  const server = serve(
    {
      fetch: app.fetch,
      port: cfg.PORT,
      hostname: cfg.HOST,
    },
    (info) => {
      console.log(
        `[bibliary] listening on http://${info.address}:${info.port} (${cfg.NODE_ENV})`,
      );
      /* Background worker: resumes queued dataset_jobs из Appwrite после
       * restart, дальше работает на enqueue triggers. Fire-and-forget
       * — ошибки логируются внутри. */
      startExtractionWorker();
    },
  );

  const shutdown = (signal: string): void => {
    console.log(`[bibliary] received ${signal}, shutting down...`);
    server.close((err) => {
      if (err) {
        console.error("[bibliary] error during shutdown:", err);
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[bibliary] forced shutdown after 10s timeout");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    console.error("[bibliary] unhandledRejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[bibliary] uncaughtException:", err);
  });
}

main().catch((err) => {
  console.error("[bibliary] fatal startup error:", err);
  process.exit(1);
});
