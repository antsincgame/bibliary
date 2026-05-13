/**
 * DomainError class smoke. Verifies the public contract that the
 * app.onError handler relies on: code, status, details, type-guard,
 * toJSON serialization, cause chain.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DomainError, isDomainError } from "../server/lib/errors.ts";

describe("DomainError", () => {
  it("default status is 400; code + name set correctly", () => {
    const err = new DomainError("user_not_found");
    assert.equal(err.code, "user_not_found");
    assert.equal(err.status, 400);
    assert.equal(err.name, "DomainError");
    assert.equal(err.message, "user_not_found");
    assert.equal(err.details, undefined);
  });

  it("explicit status flows through", () => {
    const err = new DomainError("cannot_delete_last_admin", { status: 409 });
    assert.equal(err.status, 409);
  });

  it("details preserved as structured field", () => {
    const err = new DomainError("rate_limited", {
      status: 429,
      details: { retryAfter: 30 },
    });
    assert.deepEqual(err.details, { retryAfter: 30 });
  });

  it("toJSON shape: { error, details? }", () => {
    const a = new DomainError("missing").toJSON();
    assert.deepEqual(a, { error: "missing" });
    const b = new DomainError("missing", { details: { k: 1 } }).toJSON();
    assert.deepEqual(b, { error: "missing", details: { k: 1 } });
  });

  it("preserves cause across throw chain", () => {
    const original = new Error("upstream gone");
    const err = new DomainError("upstream_unavailable", {
      status: 503,
      cause: original,
    });
    assert.equal(err.cause, original);
  });

  it("isDomainError type-guard: positive + negative + non-Error", () => {
    assert.equal(isDomainError(new DomainError("x")), true);
    assert.equal(isDomainError(new Error("not a domain error")), false);
    assert.equal(isDomainError("string"), false);
    assert.equal(isDomainError(null), false);
    assert.equal(isDomainError(undefined), false);
    assert.equal(isDomainError({ code: "fake" }), false);
  });

  it("captures a real stack trace", () => {
    const err = new DomainError("trace_check");
    assert.ok(err.stack && err.stack.length > 0);
    assert.ok(err.stack.includes("DomainError"));
  });
});
