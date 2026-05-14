import { serve } from "@hono/node-server";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { prewarmEmbedderInBackground } from "./lib/embedder/index.js";
import { startExportWorker } from "./lib/queue/export-queue.js";
import { startExtractionWorker } from "./lib/queue/extraction-queue.js";
import { closeStoreDb } from "./lib/store/db.js";
import { closeVectorDb } from "./lib/vectordb/db.js";

/**
 * Flush both SQLite WALs before exit. The vector DB and (in solo mode)
 * the document DB are independent better-sqlite3 handles with WAL
 * journaling — `close()` runs a synchronous checkpoint so the next
 * boot's WAL recovery doesn't roll back un-committed pages.
 * `closeStoreDb` is a no-op when solo mode never opened a connection.
 */
function flushDatabases(): void {
  for (const [label, close] of [
    ["closeVectorDb", closeVectorDb],
    ["closeStoreDb", closeStoreDb],
  ] as const) {
    try {
      close();
    } catch (err) {
      console.warn(
        `[bibliary] ${label} during shutdown failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

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
      console.log(
        cfg.BIBLIARY_SOLO
          ? "[bibliary] storage: SOLO mode — SQLite + filesystem, no Appwrite"
          : `[bibliary] storage: Appwrite (${cfg.APPWRITE_ENDPOINT ?? "?"})`,
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
      flushDatabases();
      process.exit(err ? 1 : 0);
    });
    setTimeout(() => {
      console.error("[bibliary] forced shutdown after 10s timeout");
      /* Last-ditch flush even when server.close() never resolved
       * (stuck SSE / multipart upload). */
      flushDatabases();
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
