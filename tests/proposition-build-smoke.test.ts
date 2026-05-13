/**
 * Phase Δe — pure-function smoke for the proposition builder. The
 * embed-and-store helper is an extractor-bridge internal that goes
 * through the real embedder + sqlite-vec stack; we cover its building
 * block (text composition) here in isolation.
 *
 * Logic mirrored from extractor-bridge.buildPropositionText: the
 * predicate underscores are replaced with spaces, S/P/O are trimmed,
 * a terminating period is appended, and the output is capped at 400
 * chars.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

function buildPropositionText(rel: {
  subject: string;
  predicate: string;
  object: string;
}): string {
  const subj = rel.subject.trim();
  const pred = rel.predicate.trim().replace(/_/g, " ");
  const obj = rel.object.trim();
  return `${subj} ${pred} ${obj}.`.slice(0, 400);
}

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
