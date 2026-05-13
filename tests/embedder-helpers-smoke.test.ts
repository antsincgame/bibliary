/**
 * Phase 10 — embedder helper smoke. Pure-function buildConceptEmbedText,
 * формат + порядок полей detected.
 *
 * Real model loading (xenova multilingual-e5-small) — слишком дорого
 * для unit smoke (cold-start ~5-15s + 120MB download). Integration
 * test через docker compose + real Appwrite — отдельный pipeline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildConceptEmbedText } from "../server/lib/embedder/index.ts";

describe("buildConceptEmbedText", () => {
  const sample = {
    domain: "engineering",
    essence: "Linear FEM converges at h²",
    cipher: "err = O(h²)",
    proof: "Brenner-Scott derivation Ch.2",
    tags: ["fem", "convergence", "numerical-methods"],
  };

  it("includes all five canonical fields in order", () => {
    const out = buildConceptEmbedText(sample);
    const lines = out.split("\n");
    assert.equal(lines.length, 5);
    assert.ok(lines[0].startsWith("domain:"));
    assert.ok(lines[1].startsWith("essence:"));
    assert.ok(lines[2].startsWith("cipher:"));
    assert.ok(lines[3].startsWith("tags:"));
    assert.ok(lines[4].startsWith("proof:"));
  });

  it("preserves field values", () => {
    const out = buildConceptEmbedText(sample);
    assert.ok(out.includes("engineering"));
    assert.ok(out.includes("Linear FEM converges at h²"));
    assert.ok(out.includes("err = O(h²)"));
    assert.ok(out.includes("fem, convergence, numerical-methods"));
    assert.ok(out.includes("Brenner-Scott derivation Ch.2"));
  });

  it("empty tags array still serializes cleanly", () => {
    const out = buildConceptEmbedText({ ...sample, tags: [] });
    assert.ok(out.includes("tags: \n"));
  });

  it("deterministic — same input → same output (essential для caching)", () => {
    const a = buildConceptEmbedText(sample);
    const b = buildConceptEmbedText({ ...sample });
    assert.equal(a, b);
  });

  it("multi-line essence stays inline (no internal line breaks needed)", () => {
    const out = buildConceptEmbedText({
      ...sample,
      essence: "Multi-line\nessence\nwith\nbreaks",
    });
    /* Newlines from essence preserved — embedder pipeline трактует
     * whole input as one passage, не разбивает на multi-passage. */
    assert.ok(out.includes("Multi-line\nessence\nwith\nbreaks"));
  });
});
