import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { listAuditEvents, writeAuditEvent, type AuditAction } from "../lib/audit/log.js";
import { revokeAllForUser } from "../lib/auth/sessions.js";
import { burnAllForUser } from "../lib/library/burn.js";
import { getExtractionQueue } from "../lib/queue/extraction-queue.js";
import { getJob, listAllJobs } from "../lib/queue/job-store.js";
import { ALL_JOB_STATES } from "../lib/queue/types.js";
import { computeUserStorageUsage } from "../lib/users/storage-usage.js";
import {
  countAdmins,
  deleteUserDocument,
  findUserById,
  listAllUsers,
  setUserDeactivated,
  setUserRole,
} from "../lib/users/repository.js";
import { deleteGraphForUser } from "../lib/vectordb/graph.js";
import { requireAdmin } from "../middleware/admin.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * Phase 11a — admin user management surface.
 *
 * All routes guarded by requireAuth + requireAdmin. The middlewares
 * stack means a non-admin user hits 403; an unauthenticated request
 * hits 401. Order: requireAuth populates c.get("user"); requireAdmin
 * reads user.role.
 *
 * Self-protection invariants enforced server-side (never trust UI):
 *   - cannot demote yourself (would lock you out)
 *   - cannot demote the last admin (system would be unmanageable)
 *   - cannot deactivate yourself (would log yourself out mid-action)
 *   - cannot delete yourself (would orphan the request)
 */
/** Phase 11c — capture IP + UA from the request for the audit row. */
function reqContext(c: { req: { header: (k: string) => string | undefined } }): {
  ip: string | null;
  userAgent: string | null;
} {
  const xff = c.req.header("x-forwarded-for");
  /* X-Forwarded-For can be a comma-list; first entry is the original
   * client unless the proxy chain is hostile. Trust the front of the
   * list. */
  const ip = xff ? xff.split(",")[0].trim() : c.req.header("x-real-ip") ?? null;
  const userAgent = c.req.header("user-agent") ?? null;
  return { ip: ip || null, userAgent: userAgent || null };
}

/** Phase 11c — fire-and-forget audit write inside an admin handler. */
function audit(
  c: { req: { header: (k: string) => string | undefined } },
  actorId: string | null,
  action: AuditAction,
  target: string | null,
  metadata?: Record<string, unknown>,
): void {
  const { ip, userAgent } = reqContext(c);
  void writeAuditEvent({
    userId: actorId,
    action,
    target,
    ...(metadata ? { metadata } : {}),
    ip,
    userAgent,
  });
}

export function adminRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);
  app.use("*", requireAdmin);

  const ListUsersQuery = z.object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  });

  app.get("/users", zValidator("query", ListUsersQuery), async (c) => {
    const q = c.req.valid("query");
    const opts: Parameters<typeof listAllUsers>[0] = {};
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.offset !== undefined) opts.offset = q.offset;
    const result = await listAllUsers(opts);
    return c.json(result);
  });

  app.get("/users/:userId", async (c) => {
    const userId = c.req.param("userId");
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    return c.json({
      id: u.$id,
      email: u.email,
      name: u.name,
      role: u.role,
      deactivated: u.deactivated,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      libraryQuotaBytes: u.libraryQuotaBytes,
    });
  });

  /**
   * Promote to admin. Idempotent — promoting an existing admin is a
   * no-op return. Always-safe operation: never reduces privileges.
   */
  app.post("/users/:userId/promote", async (c) => {
    const me = c.get("user");
    const userId = c.req.param("userId");
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    if (u.role === "admin") {
      return c.json({ ok: true, alreadyAdmin: true });
    }
    await setUserRole(userId, "admin");
    audit(c, me?.sub ?? null, "admin.user.promote", userId, { email: u.email });
    return c.json({ ok: true });
  });

  /**
   * Demote to regular user. Refuses to demote:
   *   - yourself (lockout-safe)
   *   - the last remaining admin (system-manageability-safe)
   */
  app.post("/users/:userId/demote", async (c) => {
    const me = c.get("user");
    if (!me) throw new HTTPException(401, { message: "auth_required" });
    const userId = c.req.param("userId");
    if (userId === me.sub) {
      throw new HTTPException(409, { message: "cannot_demote_self" });
    }
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    if (u.role !== "admin") return c.json({ ok: true, alreadyUser: true });
    const adminCount = await countAdmins();
    if (adminCount <= 1) {
      throw new HTTPException(409, { message: "cannot_demote_last_admin" });
    }
    await setUserRole(userId, "user");
    audit(c, me.sub, "admin.user.demote", userId, { email: u.email });
    return c.json({ ok: true });
  });

  /**
   * Soft deactivate — login refuses, existing sessions get revoked so
   * the affected user is logged out within one refresh cycle (15 min).
   * Refuses to deactivate self.
   */
  app.post("/users/:userId/deactivate", async (c) => {
    const me = c.get("user");
    if (!me) throw new HTTPException(401, { message: "auth_required" });
    const userId = c.req.param("userId");
    if (userId === me.sub) {
      throw new HTTPException(409, { message: "cannot_deactivate_self" });
    }
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    await setUserDeactivated(userId, true);
    const revoked = await revokeAllForUser(userId);
    audit(c, me.sub, "admin.user.deactivate", userId, {
      email: u.email,
      sessionsRevoked: revoked,
    });
    return c.json({ ok: true, sessionsRevoked: revoked });
  });

  app.post("/users/:userId/reactivate", async (c) => {
    const me = c.get("user");
    const userId = c.req.param("userId");
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    await setUserDeactivated(userId, false);
    audit(c, me?.sub ?? null, "admin.user.reactivate", userId, { email: u.email });
    return c.json({ ok: true });
  });

  /**
   * Hard delete cascade. Order matters:
   *   1. Revoke sessions (the user can't slip in mid-cascade)
   *   2. burnAllForUser → books, chunks, concepts, storage files, vec rows
   *   3. deleteGraphForUser → entities + relations
   *   4. deleteUserDocument → users collection
   * Refuses to delete self.
   */
  /**
   * Phase 11b — cross-user job inspection. Admin-only mirror of the
   * per-user /api/library/jobs route but without the userId scope.
   * Filterable by state.
   */
  const ListJobsQuery = z.object({
    state: z.enum(ALL_JOB_STATES).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  });

  app.get("/jobs", zValidator("query", ListJobsQuery), async (c) => {
    const q = c.req.valid("query");
    const opts: Parameters<typeof listAllJobs>[0] = {};
    if (q.state) opts.state = q.state;
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.offset !== undefined) opts.offset = q.offset;
    const result = await listAllJobs(opts);
    return c.json(result);
  });

  app.get("/jobs/depth", async (c) => {
    /* Current in-process queue depth: pending count + active count. */
    const depth = getExtractionQueue().getDepth();
    return c.json(depth);
  });

  /**
   * Admin cancel — overrides the per-user ownership check. Used to
   * unjam a stuck cross-user job (e.g. user X queued 50 books then
   * disappeared, admin needs to clear the queue).
   */
  app.post("/jobs/:jobId/cancel", async (c) => {
    const me = c.get("user");
    const jobId = c.req.param("jobId");
    /* getJob is per-user scoped; admin paths need to discover the
     * owner first then cancel under that user's identity. Listing by
     * jobId via getJob requires the userId — fall back to a direct
     * Appwrite read here, since this route already passed requireAdmin. */
    const { getJobRaw } = await import("../lib/queue/job-store.js");
    const job = await getJobRaw(jobId);
    if (!job) throw new HTTPException(404, { message: "job_not_found" });
    const queue = getExtractionQueue();
    const ok = await queue.cancel(job.userId, jobId);
    if (ok) {
      audit(c, me?.sub ?? null, "admin.job.cancel", jobId, {
        targetUserId: job.userId,
        bookId: job.bookId,
        priorState: job.state,
      });
    }
    return c.json({ ok });
  });

  /**
   * Phase 11b — storage usage aggregator per user. Walks books +
   * dataset exports and sums file sizes from Appwrite Storage.
   *
   * Best-effort: bounded by an 8s budget on the server side; missing
   * files don't fail the walk, just skip. Result includes `partial:
   * true` if the deadline cut things short.
   */
  app.get("/storage/usage/:userId", async (c) => {
    const userId = c.req.param("userId");
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    const usage = await computeUserStorageUsage(userId);
    return c.json(usage);
  });

  /* Re-export helper unused by direct calls but kept to keep
   * job-store's getJob import resolvable from this file. */
  void getJob;

  /**
   * Phase 11c — read the audit log. Paginated, sorted newest first.
   * Optional filters: action exact match, userId (admin doing or
   * target — depends on which one was recorded).
   */
  const ListAuditQuery = z.object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
    action: z.string().min(1).max(100).optional(),
    userId: z.string().min(1).max(64).optional(),
  });

  app.get("/audit", zValidator("query", ListAuditQuery), async (c) => {
    const q = c.req.valid("query");
    const opts: Parameters<typeof listAuditEvents>[0] = {};
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.offset !== undefined) opts.offset = q.offset;
    if (q.action) opts.action = q.action;
    if (q.userId) opts.userId = q.userId;
    const result = await listAuditEvents(opts);
    return c.json(result);
  });

  app.delete("/users/:userId", async (c) => {
    const me = c.get("user");
    if (!me) throw new HTTPException(401, { message: "auth_required" });
    const userId = c.req.param("userId");
    if (userId === me.sub) {
      throw new HTTPException(409, { message: "cannot_delete_self" });
    }
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    /* If we're deleting an admin and they're the last one — refuse. */
    if (u.role === "admin") {
      const adminCount = await countAdmins();
      if (adminCount <= 1) {
        throw new HTTPException(409, { message: "cannot_delete_last_admin" });
      }
    }
    const sessionsRevoked = await revokeAllForUser(userId);
    const burn = await burnAllForUser(userId);
    const graph = deleteGraphForUser(userId);
    await deleteUserDocument(userId);
    audit(c, me.sub, "admin.user.delete", userId, {
      email: u.email,
      role: u.role,
      sessionsRevoked,
      booksDeleted: burn.booksDeleted,
      conceptsDeleted: burn.conceptsDeleted,
      vectorRowsDeleted: burn.vectorRowsDeleted,
      relationsDeleted: graph.relationsDeleted,
      entitiesDeleted: graph.entitiesDeleted,
    });
    return c.json({
      ok: true,
      sessionsRevoked,
      booksDeleted: burn.booksDeleted,
      conceptsDeleted: burn.conceptsDeleted,
      vectorRowsDeleted: burn.vectorRowsDeleted,
      storageFilesRemoved: burn.storageFilesRemoved,
      relationsDeleted: graph.relationsDeleted,
      entitiesDeleted: graph.entitiesDeleted,
    });
  });

  return app;
}
