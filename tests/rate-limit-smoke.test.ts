/**
 * Token bucket rate-limit smoke. Не тестируем абсолютный refill (это
 * требует sleep/jest fakeTimers), а только базовый contract:
 *   - первые N запросов в bucket прошли
 *   - (N+1)-й вернул 429 + Retry-After
 *   - после reset bucket снова работает
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ENV_SNAPSHOT: Record<string, string | undefined> = {};

before(() => {
  ENV_SNAPSHOT["APPWRITE_ENDPOINT"] = process.env["APPWRITE_ENDPOINT"];
  ENV_SNAPSHOT["APPWRITE_PROJECT_ID"] = process.env["APPWRITE_PROJECT_ID"];
  ENV_SNAPSHOT["APPWRITE_API_KEY"] = process.env["APPWRITE_API_KEY"];
  ENV_SNAPSHOT["BIBLIARY_ENCRYPTION_KEY"] = process.env["BIBLIARY_ENCRYPTION_KEY"];
  process.env["APPWRITE_ENDPOINT"] = "http://localhost/v1";
  process.env["APPWRITE_PROJECT_ID"] = "test-project";
  process.env["APPWRITE_API_KEY"] = "test-key";
  if (!process.env["BIBLIARY_ENCRYPTION_KEY"]) {
    process.env["BIBLIARY_ENCRYPTION_KEY"] = "x".repeat(32);
  }
});

after(() => {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("rate-limit middleware", () => {
  beforeEach(async () => {
    const { _resetRateLimitsForTesting } = await import(
      "../server/middleware/rate-limit.ts"
    );
    _resetRateLimitsForTesting();
  });

  it("auth scope: 20-й запрос 200, 21-й — 429 c Retry-After", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const init = {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.z", password: "wrong-pass" }),
    };
    /* Первые 20 — bucket исчерпывается, но 401 (auth fail) приходит до
     * того как limiter сработает. Проверяем что НЕ 429. */
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/api/auth/login", init);
      assert.notEqual(res.status, 429, `iter ${i}: limiter сработал слишком рано`);
    }
    /* 21-й — лимитер должен ударить. */
    const blocked = await app.request("/api/auth/login", init);
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"), "Retry-After header missing");
  });

  it("разные IPs независимы", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    /* IP A исчерпывает свой bucket. */
    for (let i = 0; i < 20; i++) {
      await app.request("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.2", "content-type": "application/json" },
        body: JSON.stringify({ email: "x@y.z", password: "wrong" }),
      });
    }
    const blockedA = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.2", "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.z", password: "wrong" }),
    });
    assert.equal(blockedA.status, 429);

    /* IP B должен пройти. */
    const fromB = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.3", "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.z", password: "wrong" }),
    });
    assert.notEqual(fromB.status, 429);
  });

  it("CSP header установлен", async () => {
    const { buildApp } = await import("../server/app.ts");
    const app = buildApp();
    const res = await app.request("/health");
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "CSP header missing");
    assert.ok(csp.includes("default-src 'self'"), "CSP должен ограничивать default-src");
    assert.ok(csp.includes("frame-ancestors 'none'"), "CSP должен блокировать iframe embed");
  });
});
