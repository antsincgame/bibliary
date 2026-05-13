import { Hono } from "hono";

import type { AppEnv } from "../app.js";
import { requireAuth } from "../middleware/auth.js";

import { registerCatalogRoutes } from "./library-catalog.js";
import { registerCrystallizationRoutes } from "./library-crystallization.js";
import { registerIngestionRoutes } from "./library-ingestion.js";

/**
 * Composition root for /api/library/* endpoints.
 *
 * Phase Round-3 god-object split: the previous 547-LOC file is now a
 * thin barrel that wires three responsibility-scoped registrars onto
 * a single Hono sub-app with one shared auth middleware:
 *
 *   ./library-catalog.ts         read-only catalog + file fetch + DELETE
 *   ./library-crystallization.ts evaluate / extract / batches / jobs / burn-all
 *   ./library-ingestion.ts       upload + import-files
 *
 * Each registrar takes the Hono app and adds its endpoints; route
 * paths are intentionally namespaced so reordering registrars cannot
 * cause routing collisions.
 */
export function libraryRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  registerCatalogRoutes(app);
  registerCrystallizationRoutes(app);
  registerIngestionRoutes(app);

  return app;
}
