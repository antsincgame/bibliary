/**
 * Phase 8b — ShareGPT synthesizer smoke. Тестируем pure-функции
 * без Appwrite/LLM:
 *   - buildShareGptLine: shape сборки conversations + metadata
 *   - QAPairSchema validation: длины question/answer enforced
 *
 * Real LLM Q&A generation (через crystallizer role) — integration test
 * с docker compose + Appwrite, не в этом suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { QAPairSchema, buildShareGptLine, type QAPair } from "../server/lib/datasets/sharegpt.ts";
import type { JsonlLine } from "../server/lib/datasets/synthesize.ts";
import type { DeltaKnowledge } from "../shared/llm/extractor-schema.ts";

function makeDelta(overrides: Partial<DeltaKnowledge> = {}): DeltaKnowledge {
  return {
    domain: "engineering",
    chapterContext: "FEM convergence analysis on uniform meshes.",
    essence:
      "Mesh refinement reduces FEM approximation error quadratically when basis functions are linear and the mesh is uniform.",
    cipher: "FEM_error = O(h^2)",
    proof: "Brenner-Scott Ch.2 derives ||u - u_h|| ≤ C h^2 ||u''||.",
    applicability: "Baseline expectation for uniform linear FEM.",
    auraFlags: ["specialization", "causality"],
    tags: ["fem", "convergence"],
    relations: [
      { subject: "uniform_mesh", predicate: "enables", object: "quadratic_convergence" },
    ],
    ...overrides,
  };
}

function makeJsonlLine(deltaOverrides: Partial<DeltaKnowledge> = {}): JsonlLine {
  return {
    conceptId: "c-test-1",
    bookId: "b-test-1",
    collectionName: "training-v1",
    createdAt: "2026-05-12T13:00:00Z",
    delta: makeDelta(deltaOverrides),
  };
}

describe("ShareGPT line builder", () => {
  it("conversations array order: system → human → gpt", () => {
    const qa: QAPair = {
      question: "Why does linear FEM converge as O(h²) on uniform meshes?",
      answer:
        "Linear basis functions interpolate exactly up to second derivatives modulo a second-order remainder; on uniform meshes the constants align so the error in H¹ norm scales as h².",
    };
    const line = buildShareGptLine(makeJsonlLine(), qa);
    assert.equal(line.conversations.length, 3);
    assert.equal(line.conversations[0].from, "system");
    assert.equal(line.conversations[1].from, "human");
    assert.equal(line.conversations[2].from, "gpt");
  });

  it("system message включает domain из delta", () => {
    const qa: QAPair = {
      question: "Explain quadratic convergence in linear FEM.",
      answer:
        "Linear FEM achieves O(h^2) convergence in the H1 seminorm because the interpolation error of piecewise linear functions is itself O(h^2) under standard regularity assumptions.",
    };
    const line = buildShareGptLine(makeJsonlLine(), qa);
    assert.ok(line.conversations[0].value.includes("engineering"));
    assert.ok(line.conversations[0].value.toLowerCase().includes("expert"));
  });

  it("metadata preserves provenance fields", () => {
    const qa: QAPair = {
      question: "Why does linear FEM converge as O(h²) on uniform meshes?",
      answer:
        "Linear basis functions reproduce constants and linears; the interpolation error in H1 is bounded by O(h²)·norm of second derivative, hence overall convergence is quadratic on uniform meshes.",
    };
    const line = buildShareGptLine(makeJsonlLine(), qa);
    assert.equal(line.metadata.conceptId, "c-test-1");
    assert.equal(line.metadata.bookId, "b-test-1");
    assert.equal(line.metadata.collectionName, "training-v1");
    assert.equal(line.metadata.domain, "engineering");
    assert.deepEqual(line.metadata.auraFlags, ["specialization", "causality"]);
  });

  it("JSON.stringify produces single-line output (no embedded newlines crash JSONL)", () => {
    const qa: QAPair = {
      question: "Multi-line\nquestion test.",
      answer: "Multi-line\nanswer test that's long enough to pass schema validation here please please.",
    };
    const line = buildShareGptLine(makeJsonlLine(), qa);
    const serialized = JSON.stringify(line);
    /* Newlines inside string fields ARE preserved as \n escape — they don't
     * break JSONL line-per-record because the SERIALIZATION quotes them. */
    assert.equal(serialized.split("\n").length, 1, "serialized line must be single newline-free string");
    /* Round-trip verifies escapes survive. */
    const parsed = JSON.parse(serialized);
    assert.ok(parsed.conversations[1].value.includes("\n"));
  });
});

describe("ShareGPT QA schema", () => {
  it("rejects question < 20 chars", () => {
    const r = QAPairSchema.safeParse({ question: "Too short.", answer: "x".repeat(50) });
    assert.equal(r.success, false);
  });

  it("rejects answer < 40 chars", () => {
    const r = QAPairSchema.safeParse({ question: "x".repeat(40), answer: "Too short answer." });
    assert.equal(r.success, false);
  });

  it("accepts valid Q&A within length bounds", () => {
    const r = QAPairSchema.safeParse({
      question: "Why does uniform mesh enable quadratic convergence?",
      answer:
        "Because the interpolation error of piecewise linear functions is bounded above by a constant times h squared times the L2 norm of second derivatives — and this bound is sharp on uniform meshes.",
    });
    assert.equal(r.success, true);
  });

  it("rejects answer > 2000 chars (sanity hard cap)", () => {
    const r = QAPairSchema.safeParse({
      question: "x".repeat(40),
      answer: "z".repeat(2001),
    });
    assert.equal(r.success, false);
  });
});
