/**
 * Phase Δe — pure-function smoke for the proposition builder.
 *
 * Post-merge fix: imports `buildPropositionText` from the production
 * module instead of a local copy. The previous copy was a contract
 * test that would have silently passed against stale logic if the
 * implementation drifted. Now this is a real integration check of
 * the exported helper.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPropositionText } from "../server/lib/library/proposition-builder.ts";

describe("buildPropositionText", () => {
  it("composes 'subject predicate object.' with underscore→space predicates", () => {
    assert.equal(
      buildPropositionText({
        subject: "Saturn V",
        predicate: "designed_by",
        object: "Wernher von Braun",
      }),
      "Saturn V designed by Wernher von Braun.",
    );
  });

  it("trims whitespace around S/P/O", () => {
    assert.equal(
      buildPropositionText({
        subject: "  FEM error ",
        predicate: " decreases_as ",
        object: " O(h^2)\t",
      }),
      "FEM error decreases as O(h^2).",
    );
  });

  it("caps at 400 chars to defend against pathological emissions", () => {
    const long = "x".repeat(500);
    const r = buildPropositionText({ subject: long, predicate: "is", object: long });
    assert.ok(r.length <= 400);
  });

  it("preserves predicates that already contain spaces", () => {
    assert.equal(
      buildPropositionText({
        subject: "Apollo 11",
        predicate: "landed on",
        object: "the Moon",
      }),
      "Apollo 11 landed on the Moon.",
    );
  });

  it("normalizes multi-underscore predicates", () => {
    assert.equal(
      buildPropositionText({
        subject: "X",
        predicate: "is_caused_by",
        object: "Y",
      }),
      "X is caused by Y.",
    );
  });
});
