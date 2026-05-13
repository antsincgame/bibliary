/**
 * Branded ID types — verify the runtime helpers behave correctly. The
 * compile-time brand discipline is the real value; tests here cover
 * the format guards and the documented zero-cost cast behaviour.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  asBookId,
  asCollectionName,
  asUserId,
  isValidAppwriteId,
  parseBookId,
  parseCollectionName,
  parseJobId,
  parseUserId,
  type BookId,
  type CollectionName,
  type UserId,
} from "../shared/branded.ts";

describe("branded ID types", () => {
  it("cast helpers are zero-cost identity at runtime", () => {
    const raw = "abc123";
    const u: UserId = asUserId(raw);
    const b: BookId = asBookId(raw);
    /* Brands are phantom — same string at runtime. */
    assert.equal(u, raw);
    assert.equal(b, raw);
    assert.equal(u === raw, true);
  });

  it("isValidAppwriteId accepts well-formed Appwrite-style ids", () => {
    assert.equal(isValidAppwriteId("abc123"), true);
    assert.equal(isValidAppwriteId("CamelCaseId"), true);
    assert.equal(isValidAppwriteId("with_underscore"), true);
    assert.equal(isValidAppwriteId("64chars"), true);
  });

  it("isValidAppwriteId rejects empties, hyphens, dots, overlong", () => {
    assert.equal(isValidAppwriteId(""), false);
    assert.equal(isValidAppwriteId("has-hyphen"), false);
    assert.equal(isValidAppwriteId("has.dot"), false);
    assert.equal(isValidAppwriteId("has space"), false);
    assert.equal(isValidAppwriteId("x".repeat(37)), false);
    assert.equal(isValidAppwriteId(null), false);
    assert.equal(isValidAppwriteId(undefined), false);
    assert.equal(isValidAppwriteId(42), false);
  });

  it("parseUserId / parseBookId / parseJobId narrow at trust boundaries", () => {
    const ok = parseUserId("real_id_123");
    assert.ok(ok);
    assert.equal(ok, "real_id_123");

    assert.equal(parseUserId("bad-id"), null);
    assert.equal(parseUserId(""), null);
    assert.equal(parseUserId(null), null);

    /* Same regex for all three flavours of Appwrite id. */
    assert.ok(parseBookId("book_42"));
    assert.ok(parseJobId("job_xyz"));
  });

  it("parseCollectionName allows hyphens (unlike Appwrite ids)", () => {
    const ok = parseCollectionName("training-v1");
    assert.ok(ok);
    assert.equal(ok, "training-v1");
    assert.ok(parseCollectionName("alpha_beta-gamma"));
    assert.equal(parseCollectionName("has space"), null);
    assert.equal(parseCollectionName("has.dot"), null);
    assert.equal(parseCollectionName(""), null);
  });

  it("asCollectionName is a documentation cast — no runtime check", () => {
    /* asCollectionName trusts the caller; the runtime check is on
     * parseCollectionName. Useful when you've already validated via
     * zod at the route boundary. */
    const c: CollectionName = asCollectionName("anything goes here");
    assert.equal(c, "anything goes here");
  });
});
