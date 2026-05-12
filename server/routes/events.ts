import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";

import type { AppEnv } from "../app.js";
import { subscribe, type BusEvent } from "../lib/realtime/event-bus.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * Server-Sent Events stream — один long-lived HTTP connection per user
 * session. SSE protocol → каждое сообщение `event: <channel>\ndata: <json>\n\n`,
 * браузер EventSource API парсит автоматом.
 *
 * Auth-bound: requireAuth выставляет `c.get("user")`, мы фильтруем
 * publishUser события по `user.sub`. Global events видят все
 * аутентифицированные подписчики.
 *
 * Keep-alive ping раз в 25s (короче дефолтного 60s timeout reverse-proxy
 * как у nginx/Traefik). Когда renderer закрывает вкладку — TCP RST →
 * stream finally → unsubscribe + cleanup.
 */
export function eventsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  app.get("/", (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "auth_required" });

    return streamSSE(c, async (stream) => {
      const queue: BusEvent[] = [];
      let resolveWaiter: (() => void) | null = null;
      let aborted = false;

      const unsubscribe = subscribe(user.sub, (event) => {
        queue.push(event);
        if (resolveWaiter) {
          const r = resolveWaiter;
          resolveWaiter = null;
          r();
        }
      });

      stream.onAbort(() => {
        aborted = true;
        unsubscribe();
        if (resolveWaiter) {
          const r = resolveWaiter;
          resolveWaiter = null;
          r();
        }
      });

      /* Initial ping — браузер сразу понимает что connection alive,
       * иначе при первом долгом тишине Chrome может закрыть. */
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ ts: Date.now() }) });

      const pingTimer = setInterval(() => {
        if (aborted) return;
        queue.push({ channel: "ping", payload: { ts: Date.now() } });
        if (resolveWaiter) {
          const r = resolveWaiter;
          resolveWaiter = null;
          r();
        }
      }, 25_000);
      pingTimer.unref();

      try {
        while (!aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              resolveWaiter = resolve;
            });
          }
          while (queue.length > 0 && !aborted) {
            const ev = queue.shift();
            if (!ev) continue;
            await stream.writeSSE({
              event: ev.channel,
              data: JSON.stringify(ev.payload),
            });
          }
        }
      } finally {
        clearInterval(pingTimer);
        unsubscribe();
      }
    });
  });

  return app;
}
