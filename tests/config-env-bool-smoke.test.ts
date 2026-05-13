/**
 * Regression test for the `z.coerce.boolean()` env-var parsing trap.
 *
 * Stock z.coerce.boolean uses JS Boolean() which returns true for any
 * non-empty string, including "false" and "0". This means an operator
 * who sets COOKIE_SECURE=false in .env would silently get secure
 * cookies turned ON — opposite of intent. Same for
 * BIBLIARY_REGISTRATION_DISABLED.
 *
 * server/config.ts:envBool() replaces z.coerce.boolean with explicit
 * string parsing. This suite locks the contract.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const ENV_SNAPSHOT: Record<string, string | undefined> = {};

before(() => {
  for (const k of [
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_API_KEY",
    "COOKIE_SECURE",
    "BIBLIARY_REGISTRATION_DISABLED",
    "NODE_ENV",
  ]) {
    ENV_SNAPSHOT[k] = process.env[k];
  }
  process.env["APPWRITE_ENDPOINT"] = "http://localhost/v1";
  process.env["APPWRITE_PROJECT_ID"] = "test";
  process.env["APPWRITE_API_KEY"] = "test";
  process.env["NODE_ENV"] = "development";
});

after(() => {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function loadFresh(): Promise<typeof import("../server/config.ts")> {
  const mod = await import("../server/config.ts");
  mod.resetConfigForTesting();
  return mod;
}

describe("envBool — string-to-boolean parsing for .env vars", () => {
  it("COOKIE_SECURE='false' parses as FALSE (not the JS Boolean('false')===true trap)", async () => {
    process.env["COOKIE_SECURE"] = "false";
    const { loadConfig } = await loadFresh();
    const cfg = loadConfig();
    assert.equal(cfg.COOKIE_SECURE, false, "literal 'false' must become false");
  });

  it("COOKIE_SECURE='true' parses as TRUE", async () => {
    process.env["COOKIE_SECURE"] = "true";
    const { loadConfig } = await loadFresh();
    assert.equal(loadConfig().COOKIE_SECURE, true);
  });

  it("COOKIE_SECURE='0' parses as FALSE", async () => {
    process.env["COOKIE_SECURE"] = "0";
    const { loadConfig } = await loadFresh();
    assert.equal(loadConfig().COOKIE_SECURE, false);
  });

  it("COOKIE_SECURE='1' parses as TRUE", async () => {
    process.env["COOKIE_SECURE"] = "1";
    const { loadConfig } = await loadFresh();
    assert.equal(loadConfig().COOKIE_SECURE, true);
  });

  it("COOKIE_SECURE unset uses default (false)", async () => {
    delete process.env["COOKIE_SECURE"];
    const { loadConfig } = await loadFresh();
    assert.equal(loadConfig().COOKIE_SECURE, false);
  });

  it("COOKIE_SECURE='yes' / 'no' / 'on' / 'off' all work", async () => {
    process.env["COOKIE_SECURE"] = "yes";
    let m = await loadFresh();
    assert.equal(m.loadConfig().COOKIE_SECURE, true);
    process.env["COOKIE_SECURE"] = "no";
    m = await loadFresh();
    assert.equal(m.loadConfig().COOKIE_SECURE, false);
    process.env["COOKIE_SECURE"] = "on";
    m = await loadFresh();
    assert.equal(m.loadConfig().COOKIE_SECURE, true);
    process.env["COOKIE_SECURE"] = "off";
    m = await loadFresh();
    assert.equal(m.loadConfig().COOKIE_SECURE, false);
  });

  it("COOKIE_SECURE='flase' (typo) FAILS validation — defense against misspell", async () => {
    process.env["COOKIE_SECURE"] = "flase";
    const { loadConfig } = await loadFresh();
    assert.throws(
      () => loadConfig(),
      /expected one of: true\/false\/1\/0\/yes\/no\/on\/off/,
    );
    /* Reset after typo test so it doesn't poison later cases. */
    delete process.env["COOKIE_SECURE"];
  });

  it("BIBLIARY_REGISTRATION_DISABLED='false' parses as FALSE (operator can re-open registration)", async () => {
    process.env["BIBLIARY_REGISTRATION_DISABLED"] = "false";
    const { loadConfig } = await loadFresh();
    assert.equal(
      loadConfig().BIBLIARY_REGISTRATION_DISABLED,
      false,
      "must be false — operator typed false explicitly; old z.coerce.boolean would have flipped this to true",
    );
  });

  it("production guard fires on COOKIE_SECURE='false' (intended unsafe config blocked)", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["COOKIE_SECURE"] = "false";
    process.env["JWT_PRIVATE_KEY_PEM"] = "x".repeat(50);
    process.env["JWT_PUBLIC_KEY_PEM"] = "x".repeat(50);
    process.env["BIBLIARY_ENCRYPTION_KEY"] = "x".repeat(32);
    const { loadConfig } = await loadFresh();
    assert.throws(() => loadConfig(), /COOKIE_SECURE.*must be true when NODE_ENV=production/);
    delete process.env["JWT_PRIVATE_KEY_PEM"];
    delete process.env["JWT_PUBLIC_KEY_PEM"];
    delete process.env["BIBLIARY_ENCRYPTION_KEY"];
    process.env["NODE_ENV"] = "development";
  });
});
