/**
 * Unit tests for per-domain preset resolution in dataset-synth.ts.
 *
 * Iter 9: trainer prompts are now domain-aware. We verify the matching
 * algorithm picks the right preset and falls back gracefully.
 *
 * Note: full PresetResolver is private to dataset-synth.ts. We test the
 * pure pickPresetForDomain() logic via a duplicated reference impl
 * (kept identical to the script — Phase 12 acknowledges this and the
 * fix on bugs would update both). Production callers go through the
 * resolver class which is integration-tested by `npm run dataset:synth`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";

interface PresetEntry {
  file: string;
  label: string;
  matchDomains: string[];
}
interface PresetIndex { presets: Record<string, PresetEntry>; }

/**
 * Reference implementation — mirrors PresetResolver.pickPresetForDomain in
 * scripts/dataset-synth.ts. If you change one, change the other.
 */
function pickPresetForDomain(domain: string, index: PresetIndex): string {
  const dom = domain.toLowerCase();
  let bestName = "default";
  let bestScore = 0;
  for (const [name, entry] of Object.entries(index.presets)) {
    if (name === "default") continue;
    let score = 0;
    for (const kw of entry.matchDomains) {
      if (dom.includes(kw.toLowerCase())) score += kw.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  return bestName;
}

let INDEX: PresetIndex;

test.before(async () => {
  const idxPath = path.resolve(process.cwd(), "electron", "defaults", "synth-prompts", "index.json");
  INDEX = JSON.parse(await fs.readFile(idxPath, "utf8")) as PresetIndex;
});

test("[1] index.json has all 10 documented presets", () => {
  assert.ok(INDEX.presets.default,    "missing 'default'");
  assert.ok(INDEX.presets.marketing,  "missing 'marketing'");
  assert.ok(INDEX.presets.ux,         "missing 'ux'");
  assert.ok(INDEX.presets.seo,        "missing 'seo'");
  assert.ok(INDEX.presets.programming,"missing 'programming'");
  assert.ok(INDEX.presets.security,   "missing 'security'");
  assert.ok(INDEX.presets.science,    "missing 'science'");
  assert.ok(INDEX.presets.philosophy, "missing 'philosophy'");
  assert.ok(INDEX.presets.business,   "missing 'business'");
  assert.ok(INDEX.presets.psychology, "missing 'psychology'");
});

test("[2] every preset .md file exists on disk", async () => {
  const dir = path.resolve(process.cwd(), "electron", "defaults", "synth-prompts");
  for (const [name, entry] of Object.entries(INDEX.presets)) {
    const filePath = path.join(dir, entry.file);
    await fs.access(filePath); /* throws if missing */
    const content = await fs.readFile(filePath, "utf8");
    assert.ok(content.length > 100, `preset ${name} too short: ${content.length} chars`);
    assert.ok(content.includes("{{domain}}"), `preset ${name} missing {{domain}} placeholder`);
  }
});

test("[3] exact-match domain → correct preset", () => {
  assert.equal(pickPresetForDomain("marketing", INDEX), "marketing");
  assert.equal(pickPresetForDomain("ux", INDEX), "ux");
  assert.equal(pickPresetForDomain("seo", INDEX), "seo");
  assert.equal(pickPresetForDomain("security", INDEX), "security");
  assert.equal(pickPresetForDomain("philosophy", INDEX), "philosophy");
});

test("[4] compound domain → most specific preset wins (longer keyword match)", () => {
  /* "user experience design" should pick ux (matches "user experience" + "design"),
     not philosophy (no overlap). */
  assert.equal(pickPresetForDomain("user experience design", INDEX), "ux");
  /* "behavioral economics" matches psychology only. */
  assert.equal(pickPresetForDomain("behavioral economics", INDEX), "psychology");
  /* "AI-assisted software development" matches programming. */
  assert.equal(pickPresetForDomain("AI-assisted software development", INDEX), "programming");
});

test("[5] real domains seen in production Qdrant payload", () => {
  /* Sampled from actual book.md outputs of the Pre-flight Evaluator. */
  assert.equal(pickPresetForDomain("financial documentation", INDEX), "business");
  assert.equal(pickPresetForDomain("administrative accounting", INDEX), "business");
  assert.equal(pickPresetForDomain("technical seo", INDEX), "seo");
  assert.equal(pickPresetForDomain("interaction design", INDEX), "ux");
  assert.equal(pickPresetForDomain("growth marketing", INDEX), "marketing");
});

test("[6] unknown domain falls back to 'default'", () => {
  assert.equal(pickPresetForDomain("ancient hieroglyphs", INDEX), "default");
  assert.equal(pickPresetForDomain("", INDEX), "default");
  assert.equal(pickPresetForDomain("xyz123 quantum tea", INDEX), "default");
});

test("[7] case-insensitivity", () => {
  assert.equal(pickPresetForDomain("MARKETING", INDEX), "marketing");
  assert.equal(pickPresetForDomain("UX", INDEX), "ux");
  assert.equal(pickPresetForDomain("Cybersecurity Engineering", INDEX), "security");
});

test("[8] domain containing keyword as substring still matches", () => {
  /* "advanced metaphysics seminar" → philosophy (contains 'metaphysics'). */
  assert.equal(pickPresetForDomain("advanced metaphysics seminar", INDEX), "philosophy");
  /* "modern javascript engineering" → programming (matches javascript + engineering). */
  assert.equal(pickPresetForDomain("modern javascript engineering", INDEX), "programming");
});

test("[9] no keyword shorter than 2 chars to avoid false-positive substring hits", () => {
  /* Defensive check on the index — keywords must be discriminating. */
  for (const [name, entry] of Object.entries(INDEX.presets)) {
    for (const kw of entry.matchDomains) {
      assert.ok(kw.length >= 2, `preset ${name} keyword too short: '${kw}'`);
    }
  }
});

test("[10] tie-breaking: 'mobile design' matches both ui (in programming) and design (in ux) — ux wins via 'design' token length", () => {
  /* 'design' (6 chars, ux) > 'ui' (2 chars, programming) → ux. This guards against
     us accidentally moving the keyword scoring from longest-match to first-match. */
  const r = pickPresetForDomain("mobile design", INDEX);
  assert.equal(r, "ux", `expected ux, got ${r}`);
});
