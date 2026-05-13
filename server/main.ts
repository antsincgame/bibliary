import { serve } from "@hono/node-server";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { prewarmEmbedderInBackground } from "./lib/embedder/index.js";
import { startExportWorker } from "./lib/queue/export-queue.js";
import { startExtractionWorker } from "./lib/queue/extraction-queue.js";
import { closeVectorDb } from "./lib/vectordb/db.js";

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
      /* Background workers: each resumes its own queued docs from the
       * shared dataset_jobs collection (extraction filters out
       * stage="build:*", export filters those IN — see
       * job-store.isExportJobStage). Both are fire-and-forget; errors
       * are logged inside the worker. */
      startExtractionWorker();
      startExportWorker();
      /* Pre-warm the embedder so the first user-facing /search or
       * crystallization extraction doesn't pay the 5-15s ONNX cold
       * start. Fire-and-forget; failures fall back to lazy load on
       * first real call. */
      prewarmEmbedderInBackground();
    },
  );

  const shutdown = (signal: string): void => {
    console.log(`[bibliary] received ${signal}, shutting down...`);
    server.close((err) => {
      if (err) {
        console.error("[bibliary] error during shutdown:", err);
      }
      /* Flush sqlite-vec WAL before exit — without this the 10s
       * force-exit fallback can leave the WAL un-checkpointed and the
       * next boot's WAL recovery may roll back un-committed pages.
       * better-sqlite3.close() runs sqlite3_close() which forces a
       * full WAL checkpoint synchronously. */
      try {
        closeVectorDb();
      } catch (closeErr) {
        console.warn(
          "[bibliary] closeVectorDb during shutdown failed:",
          closeErr instanceof Error ? closeErr.message : closeErr,
        );
      }
      process.exit(err ? 1 : 0);
    });
    setTimeout(() => {
      console.error("[bibliary] forced shutdown after 10s timeout");
      try {
        /* Last-ditch attempt to flush WAL even when server.close()
         * never resolved (stuck SSE / multipart upload). */
        closeVectorDb();
      } catch {
        /* swallow — we're force-exiting anyway */
      }
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
