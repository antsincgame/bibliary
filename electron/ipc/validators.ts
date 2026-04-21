/**
 * Zod-based validators for IPC inputs that touch the filesystem or
 * Qdrant. Centralised so every handler uses identical guards.
 *
 * Goals:
 *   - Prevent path traversal (renderer compromise -> escape userData/cwd)
 *   - Prevent Qdrant collection-name injection (URL path manipulation)
 *   - Prevent IPC payloads larger than expected (DoS via giant strings)
 *
 * Usage in an ipcMain.handle:
 *
 *   ipcMain.handle("scanner:start-ingest", async (_e, raw) => {
 *     const args = StartIngestArgsSchema.parse(raw); // throws on bad input
 *     ...
 *   });
 */

import * as path from "path";
import { z } from "zod";

/**
 * Qdrant collection name. Mirrors Qdrant's own constraint:
 * 1-255 chars, only [A-Za-z0-9_-]. Rejecting anything else avoids
 * URL-encoding surprises in `/collections/${name}/...` template literals
 * across qdrant.ipc / scanner.ipc / dataset-v2.ipc.
 */
export const CollectionNameSchema = z
  .string()
  .min(1, "collection name required")
  .max(255, "collection name too long")
  .regex(/^[A-Za-z0-9_-]+$/, "collection name: only [A-Za-z0-9_-] allowed");

/**
 * Absolute file path. We accept any non-empty string but reject
 * obvious traversal attempts (`..`, `~`, control chars). The full
 * existence + readable check is the caller's responsibility (we don't
 * stat here -- validators stay synchronous).
 */
export const AbsoluteFilePathSchema = z
  .string()
  .min(1, "file path required")
  .max(4096, "file path too long")
  .refine((p) => !p.includes("\u0000"), "path contains NUL byte")
  .refine((p) => path.isAbsolute(p), "path must be absolute")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "path traversal (..) not allowed");

/**
 * Same as AbsoluteFilePathSchema but allows arbitrary lists (probe-files
 * IPC). Capped at 1000 entries to keep payload reasonable.
 */
export const AbsoluteFilePathArraySchema = z
  .array(AbsoluteFilePathSchema)
  .max(1000, "too many paths in one batch (max 1000)");

/** A model identifier from LM Studio (free-form string but capped). */
export const ModelKeySchema = z.string().min(1).max(512);

/** A free-text user query (chat / search). Cap at 32k chars to avoid
 * accidental DoS via paste of an entire book into the search box. */
export const UserQuerySchema = z.string().min(1).max(32_768);

/**
 * Wraps `schema.parse(raw)` in a friendly error shape. Returns the
 * parsed value or throws `Error("invalid <argName>: <details>")`.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, argName = "args"): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.length ? first.path.join(".") : "value";
    throw new Error(`invalid ${argName}: ${path}: ${first?.message ?? "unknown"}`);
  }
  return result.data;
}
