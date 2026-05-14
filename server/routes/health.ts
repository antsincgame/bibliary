import { Hono } from "hono";

import type { AppEnv } from "../app.js";
import { getDatastore } from "../lib/datastore.js";
import { probeVectorDb } from "../lib/vectordb/db.js";
import { getVersionInfo } from "../lib/version.js";

/**
 * Health probe contract:
 *
 *   GET /health          — liveness + readiness, with dependency probes.
 *                          Returns 200 only if the SQLite store +
 *                          sqlite-vec are reachable. Returns 503 with a
 *                          `checks` map when any probe fails so
 *                          orchestrators (Coolify, Traefik, k8s) can
 *                          stop routing.
 *   GET /health/live     — pure liveness, no probes. For platforms that
 *                          need a "is the process alive" check distinct
 *                          from "is it ready to serve traffic".
 *
 * Probes are bounded by HEALTH_PROBE_TIMEOUT_MS so a wedged DB handle
 * doesn't push /health past Coolify's 5s default healthcheck timeout.
 */

const HEALTH_PROBE_TIMEOUT_MS = 2_500;

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe_timeout_${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function probeStore(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const { databases, databaseId } = getDatastore();
    /* Cheapest call we can make: get the database metadata. Doesn't
     * touch any collection or list documents. */
    await withTimeout(databases.get(databaseId), HEALTH_PROBE_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

function probeVec(): CheckResult {
  const t0 = Date.now();
  try {
    const r = probeVectorDb();
    return { ok: true, latencyMs: r.latencyMs ?? Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

export function healthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /* Pure liveness — no dependency probes. Used by k8s/Coolify when
   * a separate liveness probe is configured. */
  app.get("/health/live", (c) => {
    const v = getVersionInfo();
    return c.json({
      ok: true,
      version: v.version,
      commit: v.commit,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  /* Readiness — probes the SQLite store + sqlite-vec. Returns 503 on
   * any failure so the orchestrator stops routing traffic to a degraded
   * pod. */
  app.get("/health", async (c) => {
    const v = getVersionInfo();
    const [store, vec] = await Promise.all([
      probeStore(),
      Promise.resolve(probeVec()),
    ]);
    const ok = store.ok && vec.ok;
    const body = {
      ok,
      version: v.version,
      commit: v.commit,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: { store, vec },
    };
    return c.json(body, ok ? 200 : 503);
  });

  return app;
}
