/**
 * Boot smoke for the Hono backend (Phase 0-6b cumulative).
 *
 * Не дёргает реальный Appwrite — `getDatastore()` lazy-init, /health
 * route не требует backend connections. Этот тест ловит:
 *   - буст-ошибки от загрузки модулей (импорт ломается, top-level await
 *     валит, циклические зависимости)
 *   - регрессии конфига Zod parser
 *   - схему /health response
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const ENV_SNAPSHOT: Record<string, string | undefined> = {};

before(() => {
  ENV_SNAPSHOT["BIBLIARY_ENCRYPTION_KEY"] = process.env["BIBLIARY_ENCRYPTION_KEY"];
  ENV_SNAPSHOT["BIBLIARY_DB_PATH"] = process.env["BIBLIARY_DB_PATH"];

  /* In-memory store so /health's probe has a real DB to hit without
   * leaving a bibliary.db behind in the repo's data dir. */
  process.env["BIBLIARY_DB_PATH"] = ":memory:";
  if (!process.env["BIBLIARY_ENCRYPTION_KEY"]) {
    process.env["BIBLIARY_ENCRYPTION_KEY"] = "x".repeat(32);
  }
});

after(() => {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

describe("server boot smoke", () => {
  it("buildApp() returns a Hono instance without throwing", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    assert.ok(app, "buildApp should return an app");
    assert.equal(typeof app.fetch, "function");
    assert.equal(typeof app.request, "function");
  });

  it("/health/live always responds 200 — pure liveness probe", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/health/live");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      uptime: number;
      timestamp: string;
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");
    assert.equal(typeof body.uptime, "number");
    assert.ok(body.uptime >= 0);
    assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("/health probes the store + vec; status is consistent with the checks map", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/health");
    const body = (await res.json()) as {
      ok: boolean;
      checks?: { store?: { ok: boolean }; vec?: { ok: boolean } };
    };
    assert.ok(body.checks, "checks block missing");
    /* The document store is a local SQLite file (`:memory:` here) — it
     * MUST open in a clean test env. If this ever asserts false the
     * store probe is broken. The vec probe is env-dependent (a real
     * sqlite-vec file may or may not exist in the test scratch), so
     * only its type is guaranteed. */
    assert.equal(body.checks?.store?.ok, true, "store probe must pass — SQLite is local");
    assert.equal(typeof body.checks?.vec?.ok, "boolean");
    /* Readiness contract: ok === store && vec; HTTP status follows ok. */
    const expectedOk =
      (body.checks?.store?.ok ?? false) && (body.checks?.vec?.ok ?? false);
    assert.equal(body.ok, expectedOk);
    assert.equal(res.status, expectedOk ? 200 : 503);
  });

  it("unknown route returns 404 JSON", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/api/no-such-thing");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "not_found");
  });

  it("/api/auth/me without cookies returns 401", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/api/auth/me");
    assert.equal(res.status, 401);
  });

  it("/api/preferences without auth returns 401 (requireAuth wiring)", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/api/preferences");
    assert.equal(res.status, 401);
  });

  it("/api/library/books without auth returns 401", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/api/library/books");
    assert.equal(res.status, 401);
  });

  it("/api/library/jobs (Phase 7) without auth returns 401", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/api/library/jobs");
    assert.equal(res.status, 401);
  });

  it("/api/library/jobs/:jobId/cancel without auth returns 401", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/api/library/jobs/abc123/cancel", {
      method: "POST",
    });
    assert.equal(res.status, 401);
  });

  it("OPTIONS preflight on /api/library/books permits configured origin", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/api/library/books", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
    });
    /* CORS preflight: 204 No Content или 200 — оба ОК. */
    assert.ok(
      res.status === 204 || res.status === 200,
      `expected 204|200 from CORS preflight, got ${res.status}`,
    );
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "http://localhost:5173",
    );
  });
});
