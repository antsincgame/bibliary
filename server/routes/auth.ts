import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { getAdminEmails, loadConfig } from "../config.js";
import { writeAuditEvent } from "../lib/audit/log.js";
import {
  clearAuthCookies,
  readRefreshCookie,
  setAccessCookie,
  setRefreshCookie,
} from "../lib/auth/cookies.js";
import { hashPassword, verifyPassword } from "../lib/auth/passwords.js";
import {
  createSession,
  revokeAllForUser,
  revokeRefreshByToken,
  rotateSession,
} from "../lib/auth/sessions.js";
import {
  countUsers,
  createUser,
  findUserByEmail,
  findUserById,
  markUserLoggedIn,
  updateUserPassword,
} from "../lib/users/repository.js";
import { requireAuth } from "../middleware/auth.js";

const RegisterBody = z.object({
  email: z.string().email().toLowerCase().max(254),
  password: z.string().min(8).max(256),
  name: z.string().max(200).optional(),
});

const LoginBody = z.object({
  email: z.string().email().toLowerCase().max(254),
  password: z.string().min(1).max(256),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  createdAt: string;
  lastLoginAt: string | null;
}

function toPublicUser(u: {
  $id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  createdAt: string;
  lastLoginAt: string | null;
}): PublicUser {
  return {
    id: u.$id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

/* In-process serialization for /register so the first-user-becomes-admin
 * check is race-free on a single-pod deployment. Two simultaneous
 * registrations on an empty users collection could both observe
 * count == 0 and both promote to admin without this serialization.
 *
 * Multi-pod deployments would need Redis SETNX or Appwrite teams
 * membership-based admin instead; documented in FINAL-STATUS as a
 * deferred scale-out concern.
 */
let registerInFlight: Promise<unknown> = Promise.resolve();
async function withRegisterLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = registerInFlight;
  let release: () => void;
  registerInFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await prev;
    return await fn();
  } finally {
    release!();
  }
}

export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/register", zValidator("json", RegisterBody), async (c) => {
    const cfg = loadConfig();
    /* Pre-release: lock down public registration via env toggle. After
     * the first admin is seeded, the operator can flip
     * BIBLIARY_REGISTRATION_DISABLED=true to refuse new sign-ups; the
     * admin panel still allows seeded creation via Appwrite console
     * (programmatic /admin/users create endpoint deferred). */
    if (cfg.BIBLIARY_REGISTRATION_DISABLED) {
      throw new HTTPException(403, { message: "registration_disabled" });
    }
    const body = c.req.valid("json");

    /* Wrap the count-then-create sequence in the mutex so two
     * concurrent first-user registrations don't both promote. */
    const { user, role } = await withRegisterLock(async () => {
      const existing = await findUserByEmail(body.email);
      if (existing) {
        throw new HTTPException(409, { message: "email_already_registered" });
      }
      const isFirstUser = (await countUsers()) === 0;
      const adminEmails = getAdminEmails(cfg);
      const role: "user" | "admin" =
        isFirstUser || adminEmails.has(body.email) ? "admin" : "user";
      const passwordHash = await hashPassword(body.password);
      const created = await createUser({
        email: body.email,
        name: body.name ?? null,
        passwordHash,
        role,
      });
      return { user: created, role };
    });

    const tokens = await createSession(
      { sub: user.$id, email: user.email, role: user.role },
      { userAgent: c.req.header("user-agent") ?? undefined },
      cfg,
    );
    setAccessCookie(c, tokens.accessToken, tokens.accessTtlSec, cfg);
    setRefreshCookie(c, tokens.refreshToken, tokens.refreshExpiresAt, cfg);

    /* Phase 11c — audit registration. Captures first-user / admin-whitelist
     * promotion so an operator can audit how somebody got admin role. */
    void writeAuditEvent({
      userId: user.$id,
      action: "auth.register",
      target: user.$id,
      metadata: { email: user.email, role: user.role, autoAdmin: role === "admin" },
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        c.req.header("x-real-ip") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });

    return c.json(
      {
        user: toPublicUser(user),
        accessToken: tokens.accessToken,
        accessTtlSec: tokens.accessTtlSec,
      },
      201,
    );
  });

  app.post("/login", zValidator("json", LoginBody), async (c) => {
    const cfg = loadConfig();
    const body = c.req.valid("json");

    const user = await findUserByEmail(body.email);
    if (!user || user.deactivated) {
      throw new HTTPException(401, { message: "invalid_credentials" });
    }
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      throw new HTTPException(401, { message: "invalid_credentials" });
    }

    await markUserLoggedIn(user.$id);

    const tokens = await createSession(
      { sub: user.$id, email: user.email, role: user.role },
      { userAgent: c.req.header("user-agent") ?? undefined },
      cfg,
    );
    setAccessCookie(c, tokens.accessToken, tokens.accessTtlSec, cfg);
    setRefreshCookie(c, tokens.refreshToken, tokens.refreshExpiresAt, cfg);

    /* Phase 11c — audit login. Successful login only; failed login
     * attempts are noisy and would clutter the log. Pre-auth failure
     * audit is a separate concern (rate-limit metrics handle it). */
    void writeAuditEvent({
      userId: user.$id,
      action: "auth.login",
      target: user.$id,
      metadata: { email: user.email, role: user.role },
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        c.req.header("x-real-ip") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });

    return c.json({
      user: toPublicUser(user),
      accessToken: tokens.accessToken,
      accessTtlSec: tokens.accessTtlSec,
    });
  });

  app.post("/refresh", async (c) => {
    const cfg = loadConfig();
    const refreshToken = readRefreshCookie(c);
    if (!refreshToken) {
      throw new HTTPException(401, { message: "missing_refresh_token" });
    }

    const tokens = await rotateSession(
      refreshToken,
      async (userId) => {
        const user = await findUserById(userId);
        if (!user || user.deactivated) return null;
        return { sub: user.$id, email: user.email, role: user.role };
      },
      { userAgent: c.req.header("user-agent") ?? undefined },
      cfg,
    );
    if (!tokens) {
      clearAuthCookies(c, cfg);
      throw new HTTPException(401, { message: "invalid_refresh_token" });
    }
    setAccessCookie(c, tokens.accessToken, tokens.accessTtlSec, cfg);
    setRefreshCookie(c, tokens.refreshToken, tokens.refreshExpiresAt, cfg);
    return c.json({ accessToken: tokens.accessToken, accessTtlSec: tokens.accessTtlSec });
  });

  app.post("/logout", async (c) => {
    const cfg = loadConfig();
    const refreshToken = readRefreshCookie(c);
    if (refreshToken) {
      await revokeRefreshByToken(refreshToken);
    }
    clearAuthCookies(c, cfg);
    return c.json({ ok: true });
  });

  app.get("/me", requireAuth, async (c) => {
    const claims = c.get("user");
    if (!claims) throw new HTTPException(401, { message: "auth_required" });
    const user = await findUserById(claims.sub);
    if (!user) {
      throw new HTTPException(401, { message: "user_not_found" });
    }
    return c.json({ user: toPublicUser(user) });
  });

  app.post("/password/change", requireAuth, zValidator("json", ChangePasswordBody), async (c) => {
    const claims = c.get("user");
    if (!claims) throw new HTTPException(401, { message: "auth_required" });

    const body = c.req.valid("json");
    const user = await findUserById(claims.sub);
    if (!user) throw new HTTPException(404, { message: "user_not_found" });

    const ok = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!ok) throw new HTTPException(401, { message: "invalid_current_password" });

    const newHash = await hashPassword(body.newPassword);
    await updateUserPassword(user.$id, newHash);

    const revoked = await revokeAllForUser(user.$id);
    clearAuthCookies(c);

    return c.json({ ok: true, revokedSessions: revoked });
  });

  return app;
}
