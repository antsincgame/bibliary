import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AppEnv } from "../app.js";
import { getAdminEmails, loadConfig } from "../config.js";
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

export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/register", zValidator("json", RegisterBody), async (c) => {
    const cfg = loadConfig();
    const body = c.req.valid("json");

    const existing = await findUserByEmail(body.email);
    if (existing) {
      throw new HTTPException(409, { message: "email_already_registered" });
    }

    const isFirstUser = (await countUsers()) === 0;
    const adminEmails = getAdminEmails(cfg);
    const role: "user" | "admin" =
      isFirstUser || adminEmails.has(body.email) ? "admin" : "user";

    const passwordHash = await hashPassword(body.password);
    const user = await createUser({
      email: body.email,
      name: body.name ?? null,
      passwordHash,
      role,
    });

    const tokens = await createSession(
      { sub: user.$id, email: user.email, role: user.role },
      { userAgent: c.req.header("user-agent") ?? undefined },
      cfg,
    );
    setAccessCookie(c, tokens.accessToken, tokens.accessTtlSec, cfg);
    setRefreshCookie(c, tokens.refreshToken, tokens.refreshExpiresAt, cfg);

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
