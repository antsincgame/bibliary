import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import type { AppEnv } from "../app.js";
import { readAccessCookie } from "../lib/auth/cookies.js";
import { verifyAccessToken } from "../lib/auth/jwt.js";

function extractBearer(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue);
  return m?.[1];
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractBearer(c.req.header("authorization")) ?? readAccessCookie(c);
  if (!token) {
    throw new HTTPException(401, { message: "auth_required" });
  }
  try {
    const claims = await verifyAccessToken(token);
    c.set("user", claims);
  } catch {
    throw new HTTPException(401, { message: "invalid_token" });
  }
  await next();
});
