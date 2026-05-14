/**
 * Boot smoke for the Hono backend (Phase 0-6b cumulative).
 *
 * Не дёргает реальный Appwrite — `getAppwrite()` lazy-init, /health
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
  ENV_SNAPSHOT["APPWRITE_ENDPOINT"] = process.env["APPWRITE_ENDPOINT"];
  ENV_SNAPSHOT["APPWRITE_PROJECT_ID"] = process.env["APPWRITE_PROJECT_ID"];
  ENV_SNAPSHOT["APPWRITE_API_KEY"] = process.env["APPWRITE_API_KEY"];
  ENV_SNAPSHOT["BIBLIARY_ENCRYPTION_KEY"] = process.env["BIBLIARY_ENCRYPTION_KEY"];

  process.env["APPWRITE_ENDPOINT"] = "http://localhost/v1";
  process.env["APPWRITE_PROJECT_ID"] = "test-project";
  process.env["APPWRITE_API_KEY"] = "test-key-not-used-at-boot";
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

  it("/health returns 503 + checks map when Appwrite unreachable (test env)", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/health");
    /* In smoke tests Appwrite is a fake URL → probe fails → readiness
     * returns 503. The contract we test is: NEVER returns 200 when
     * deps are broken. With real Appwrite in production this returns
     * 200; we can't smoke-test the happy path without a live backend. */
    assert.equal(res.status, 503);
    const body = (await res.json()) as {
      ok: boolean;
      checks?: { appwrite?: { ok: boolean }; vec?: { ok: boolean } };
    };
    assert.equal(body.ok, false);
    assert.ok(body.checks, "checks block missing");
    /* Smoke env uses a fake Appwrite URL — the probe MUST fail. If
     * this asserts `true` someday it means we silently stopped
     * probing or hard-coded ok=true. The vec probe may succeed or
     * fail depending on whether a real sqlite-vec file exists in
     * the test scratch; only assert the type for that one. */
    assert.equal(
      body.checks?.appwrite?.ok,
      false,
      "appwrite probe must fail against the fake URL in smoke env",
    );
    assert.equal(typeof body.checks?.vec?.ok, "boolean");
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
