import { type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";

import { type Config, loadConfig } from "../../config.js";

export const ACCESS_COOKIE = "bibliary_at";
export const REFRESH_COOKIE = "bibliary_rt";
const REFRESH_PATH = "/api/auth/refresh";

function baseCookieOpts(cfg: Config): CookieOptions {
  const opts: CookieOptions = {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
  };
  if (cfg.COOKIE_DOMAIN) opts.domain = cfg.COOKIE_DOMAIN;
  return opts;
}

export function setAccessCookie(
  c: Context,
  token: string,
  ttlSec: number,
  cfg: Config = loadConfig(),
): void {
  setCookie(c, ACCESS_COOKIE, token, { ...baseCookieOpts(cfg), maxAge: ttlSec });
}

export function setRefreshCookie(
  c: Context,
  token: string,
  expiresAt: Date,
  cfg: Config = loadConfig(),
): void {
  const opts = baseCookieOpts(cfg);
  setCookie(c, REFRESH_COOKIE, token, {
    ...opts,
    sameSite: "Strict",
    path: REFRESH_PATH,
    expires: expiresAt,
  });
}

export function clearAuthCookies(c: Context, cfg: Config = loadConfig()): void {
  const base = baseCookieOpts(cfg);
  deleteCookie(c, ACCESS_COOKIE, { path: base.path, domain: base.domain });
  deleteCookie(c, REFRESH_COOKIE, {
    path: REFRESH_PATH,
    domain: base.domain,
  });
}

export function readAccessCookie(c: Context): string | undefined {
  return getCookie(c, ACCESS_COOKIE);
}

export function readRefreshCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE);
}
