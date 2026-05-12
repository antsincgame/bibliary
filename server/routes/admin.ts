import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { revokeAllForUser } from "../lib/auth/sessions.js";
import { burnAllForUser } from "../lib/library/burn.js";
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
    const userId = c.req.param("userId");
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    if (u.role === "admin") {
      return c.json({ ok: true, alreadyAdmin: true });
    }
    await setUserRole(userId, "admin");
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
    return c.json({ ok: true, sessionsRevoked: revoked });
  });

  app.post("/users/:userId/reactivate", async (c) => {
    const userId = c.req.param("userId");
    const u = await findUserById(userId);
    if (!u) throw new HTTPException(404, { message: "user_not_found" });
    await setUserDeactivated(userId, false);
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
