import type { Context, MiddlewareHandler } from "hono";

import type { AppEnv } from "../app.js";

/**
 * Минимальный in-process token bucket per-IP rate limiter.
 *
 * Single-pod deploy (Coolify / Docker) держит state в RAM — гонок
 * нет, persistence не нужна (на рестарте окно сбрасывается).
 *
 * Для multi-pod заменить на Redis-backed token bucket — surface не
 * меняется.
 *
 * Failure mode: 429 + `Retry-After: <sec>` header.
 */

interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

const MAX_BUCKETS = 10_000;

function getIp(c: Context<AppEnv>): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xRealIp = c.req.header("x-real-ip");
  if (xRealIp) return xRealIp;
  /* @hono/node-server закидывает remote addr в `c.env.incoming.socket.remoteAddress`.
   * Достаём через optional chains; для тестов c.env пуст → fallback. */
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

function evictOldest(): void {
  /* Тривиальная LRU-евикция при переполнении: удаляем первый ключ.
   * Map в JS preserves insertion order — первый = старейший вход. */
  const firstKey = buckets.keys().next().value;
  if (firstKey !== undefined) buckets.delete(firstKey);
}

/**
 * @param maxRequests — capacity bucket'а
 * @param windowMs    — окно за которое bucket полностью восполняется
 */
export function rateLimit(
  scope: string,
  maxRequests: number,
  windowMs: number,
): MiddlewareHandler<AppEnv> {
  if (maxRequests <= 0 || windowMs <= 0) {
    throw new Error("rateLimit: maxRequests and windowMs must be positive");
  }
  const refillPerMs = maxRequests / windowMs;

  return async (c, next) => {
    const key = `${scope}::${getIp(c)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) evictOldest();
      bucket = {
        tokens: maxRequests,
        capacity: maxRequests,
        refillPerMs,
        updatedAt: now,
      };
      buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.updatedAt;
      if (elapsed > 0) {
        bucket.tokens = Math.min(
          bucket.capacity,
          bucket.tokens + elapsed * bucket.refillPerMs,
        );
        bucket.updatedAt = now;
      }
    }

    if (bucket.tokens < 1) {
      /* Retry-After header — сколько ms до восстановления 1 token.
       * Используем c.json не HTTPException чтобы header'ы из ответа
       * пробрасывались (HTTPException.getResponse() строит свежий
       * Response, теряя c.header() set до throw). */
      const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillPerMs);
      return c.json(
        { error: "rate_limited", scope, retryAfterSec: Math.ceil(waitMs / 1000) },
        429,
        { "Retry-After": String(Math.ceil(waitMs / 1000)) },
      );
    }

    bucket.tokens -= 1;
    await next();
  };
}

/** Сбросить state — для тестов. */
export function _resetRateLimitsForTesting(): void {
  buckets.clear();
}
