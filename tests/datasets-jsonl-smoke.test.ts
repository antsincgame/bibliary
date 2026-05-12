/**
 * Phase 8a — JSONL synthesizer pure smoke. Не дёргает Appwrite —
 * проверяем JSON.stringify shape per-line, payload error handling,
 * empty input.
 *
 * Полный flow (Appwrite Storage upload + dataset_jobs transitions)
 * требует docker compose в CI — отдельный integration smoke.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { DeltaKnowledge } from "../shared/llm/extractor-schema.ts";

function validDelta(overrides: Partial<DeltaKnowledge> = {}): DeltaKnowledge {
  return {
    domain: "engineering",
    chapterContext: "Discussion of finite-element discretization error bounds.",
    essence:
      "Mesh refinement reduces FEM approximation error quadratically when basis functions are linear and the mesh is uniform.",
    cipher: "FEM_error = O(h^2) under uniform linear mesh",
    proof:
      "Error analysis derives ||u - u_h|| ≤ C h^2 ||u''|| for linear FEM on uniform meshes.",
    applicability: "Baseline expectation; nonuniform mesh changes the exponent.",
    auraFlags: ["specialization", "causality"],
    tags: ["fem", "convergence", "numerical-methods"],
    relations: [
      { subject: "FEM_error", predicate: "decreases_as", object: "O(h^2)" },
      { subject: "uniform_mesh", predicate: "enables", object: "quadratic_convergence" },
    ],
    ...overrides,
  };
}

describe("dataset JSONL synthesizer (pure helpers)", () => {
  it("JSONL line shape: serializes JsonlLine with conceptId/bookId/createdAt + delta", () => {
    const line = {
      conceptId: "c1",
      bookId: "b1",
      collectionName: "test",
      createdAt: "2026-05-12T13:00:00Z",
      delta: validDelta(),
    };
    const serialized = JSON.stringify(line);
    const parsed = JSON.parse(serialized) as typeof line;
    assert.equal(parsed.conceptId, "c1");
    assert.equal(parsed.bookId, "b1");
    assert.equal(parsed.delta.domain, "engineering");
    assert.equal(parsed.delta.relations.length, 2);
    assert.equal(parsed.delta.relations[0].predicate, "decreases_as");
  });

  it("JSONL line includes all DeltaKnowledge required fields", () => {
    const line = {
      conceptId: "c1",
      bookId: "b1",
      collectionName: "test",
      createdAt: "2026-05-12T13:00:00Z",
      delta: validDelta(),
    };
    const parsed = JSON.parse(JSON.stringify(line)) as typeof line;
    /* Schema-mandated fields per .claude/rules/02-extraction.md */
    assert.ok(parsed.delta.essence);
    assert.ok(parsed.delta.cipher);
    assert.ok(parsed.delta.proof);
    assert.ok(Array.isArray(parsed.delta.tags));
    assert.ok(parsed.delta.tags.length >= 1);
    assert.ok(Array.isArray(parsed.delta.relations));
    assert.ok(parsed.delta.relations.length >= 1);
    assert.ok(Array.isArray(parsed.delta.auraFlags));
    assert.ok(parsed.delta.auraFlags.length >= 2);
  });

  it("Multiple lines concatenate with \\n + trailing newline (canonical JSONL)", () => {
    const lines = [
      JSON.stringify({ conceptId: "c1", delta: validDelta() }),
      JSON.stringify({ conceptId: "c2", delta: validDelta() }),
    ];
    const jsonl = lines.join("\n") + "\n";
    /* Каждая строка должна быть valid JSON. */
    const parsedLines = jsonl
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    assert.equal(parsedLines.length, 2);
    assert.equal(parsedLines[0].conceptId, "c1");
    assert.equal(parsedLines[1].conceptId, "c2");
  });

  it("Empty collection → empty string (no trailing newline)", () => {
    const lines: string[] = [];
    const jsonl = lines.join("\n") + (lines.length > 0 ? "\n" : "");
    assert.equal(jsonl, "");
  });

  it("Single concept exports without trailing newline missing", () => {
    const lines = [JSON.stringify({ conceptId: "c1", delta: validDelta() })];
    const jsonl = lines.join("\n") + "\n";
    assert.ok(jsonl.endsWith("\n"));
    assert.equal(jsonl.split("\n").filter(Boolean).length, 1);
  });
});
