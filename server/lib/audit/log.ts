import { ID } from "node-appwrite";

import { COLLECTIONS, getAppwrite, type RawDoc } from "../appwrite.js";

/**
 * Phase 11c — append-only audit log writer. Lives next to the auth
 * primitives because almost every audited event is auth-adjacent
 * (login, promote, deactivate, burn). Single function, no batching:
 *
 *   1. Audit events are sparse (handful per active admin per day).
 *   2. We never want to lose one on a process crash; write through.
 *   3. The audit_log Appwrite collection has documentSecurity: false,
 *      so any auth'd-as-admin request can read all rows.
 *
 * Best-effort: writes are wrapped in a try/catch and logged on failure.
 * We don't fail the caller's request just because the audit row didn't
 * land — the cost of refusing a legitimate admin action because the
 * audit collection is unavailable is worse than the cost of a missing
 * row.
 *
 * Metadata is a JSON-stringified bag, capped at 5000 chars per the
 * audit_log schema. Callers should pre-truncate noisy fields.
 */

export type AuditAction =
  /* Authentication */
  | "auth.login"
  | "auth.logout"
  | "auth.register"
  | "auth.password_change"
  /* Admin user operations */
  | "admin.user.promote"
  | "admin.user.demote"
  | "admin.user.deactivate"
  | "admin.user.reactivate"
  | "admin.user.delete"
  /* Admin queue operations */
  | "admin.job.cancel"
  /* Library destructive operations */
  | "library.burn_all"
  | "library.book.delete";

export interface AuditEvent {
  /** Acting user id (admin doing the action OR the user themselves for self-events). */
  userId: string | null;
  action: AuditAction;
  /** What the action targeted (other userId, jobId, bookId, ...). */
  target?: string | null;
  /** Arbitrary structured context. Stringified + capped at 5000 chars. */
  metadata?: Record<string, unknown>;
  /** Source IP — best-effort from request headers. */
  ip?: string | null;
  /** User-Agent header — capped at 500 chars by schema. */
  userAgent?: string | null;
}

const METADATA_MAX_CHARS = 4900;

/**
 * Walk a shallow record and cap any string value to `max` chars.
 * Designed for audit metadata, which is typically flat key→primitive.
 * Nested objects/arrays pass through unchanged.
 */
function truncateValues(obj: Record<string, unknown>, max: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > max) {
      out[k] = v.slice(0, max - 1) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function writeAuditEvent(ev: AuditEvent): Promise<void> {
  try {
    const { databases, databaseId } = getAppwrite();
    const nowIso = new Date().toISOString();
    const doc: Record<string, unknown> = {
      action: ev.action,
      createdAt: nowIso,
    };
    if (ev.userId) doc["userId"] = ev.userId;
    if (ev.target) doc["target"] = ev.target;
    if (ev.metadata) {
      /* Two-step truncation: cap individual string values first so the
       * structure survives; only if it's still over budget replace
       * with a sentinel. Mid-JSON-string slicing produces unparseable
       * output that listAuditEvents silently drops.
       *
       * Post-merge fix: the sentinel itself can exceed METADATA_MAX_CHARS
       * if the metadata had hundreds of keys (operator passes a flat
       * bag of feature flags etc.). Cap the keys array in the sentinel
       * and report how many were dropped so the operator knows to
       * inspect upstream. */
      let serialized: string;
      try {
        const trimmed = truncateValues(ev.metadata, 500);
        serialized = JSON.stringify(trimmed);
        if (serialized.length > METADATA_MAX_CHARS) {
          const allKeys = Object.keys(ev.metadata);
          const MAX_SENTINEL_KEYS = 40;
          const keysSample = allKeys.slice(0, MAX_SENTINEL_KEYS);
          const sentinel: Record<string, unknown> = {
            __truncated: true,
            approxChars: serialized.length,
            keys: keysSample,
          };
          if (allKeys.length > MAX_SENTINEL_KEYS) {
            sentinel["keysDropped"] = allKeys.length - MAX_SENTINEL_KEYS;
          }
          serialized = JSON.stringify(sentinel);
          /* Final defensive: even the sentinel can theoretically exceed
           * cap if a single key name is huge. Hard-truncate as last resort. */
          if (serialized.length > METADATA_MAX_CHARS) {
            serialized = JSON.stringify({
              __truncated: true,
              reason: "sentinel_oversized",
              keyCount: allKeys.length,
            });
          }
        }
      } catch {
        serialized = JSON.stringify({ __truncated: true, reason: "stringify_failed" });
      }
      doc["metadata"] = serialized;
    }
    if (ev.ip) doc["ip"] = ev.ip.slice(0, 64);
    if (ev.userAgent) doc["userAgent"] = ev.userAgent.slice(0, 500);
    await databases.createDocument(databaseId, COLLECTIONS.auditLog, ID.unique(), doc);
  } catch (err) {
    console.warn(
      "[audit] write failed:",
      err instanceof Error ? err.message : err,
      "event:",
      ev.action,
    );
  }
}

/**
 * Phase 11c — paginated reader for the admin Audit tab. Filterable by
 * action prefix, target user, or time window. Returns the most recent
 * events first.
 */
export interface AuditRow {
  id: string;
  userId: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export async function listAuditEvents(opts: {
  limit?: number;
  offset?: number;
  /** Optional substring filter on action — exact match by Appwrite Query.equal. */
  action?: string;
  /** Optional userId filter (admin OR target). */
  userId?: string;
} = {}): Promise<{ rows: AuditRow[]; total: number }> {
  /* Dynamic Query import — keeps the audit module light when only the
   * write path is used. */
  const { Query } = await import("node-appwrite");
  const { databases, databaseId } = getAppwrite();
  const queries: string[] = [
    Query.orderDesc("createdAt"),
    Query.limit(Math.max(1, Math.min(200, opts.limit ?? 50))),
    Query.offset(Math.max(0, opts.offset ?? 0)),
  ];
  if (opts.action) queries.push(Query.equal("action", opts.action));
  if (opts.userId) queries.push(Query.equal("userId", opts.userId));
  const list = await databases.listDocuments<RawDoc & {
    userId?: string;
    action: string;
    target?: string;
    metadata?: string;
    ip?: string;
    userAgent?: string;
    createdAt: string;
  }>(databaseId, COLLECTIONS.auditLog, queries);
  const rows: AuditRow[] = list.documents.map((r) => {
    let parsed: Record<string, unknown> | null = null;
    if (typeof r.metadata === "string" && r.metadata.length > 0) {
      try {
        const v = JSON.parse(r.metadata);
        if (v && typeof v === "object") parsed = v as Record<string, unknown>;
      } catch {
        /* drop malformed */
      }
    }
    return {
      id: r.$id,
      userId: r.userId ?? null,
      action: r.action,
      target: r.target ?? null,
      metadata: parsed,
      ip: r.ip ?? null,
      userAgent: r.userAgent ?? null,
      createdAt: r.createdAt,
    };
  });
  return { rows, total: list.total };
}
