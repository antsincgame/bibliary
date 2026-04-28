/**
 * Unit tests for electron/lib/dataset-v2/export.ts
 *
 * Tests the template-based concept→ShareGPT conversion logic.
 * Qdrant calls are NOT tested here (they require a live server);
 * we only test the pure deterministic functions.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { conceptToShareGPT } from "../electron/lib/dataset-v2/export.ts";

const BASE_CONCEPT = {
  id: "c-001",
  domain: "маркетинг",
  essence: "Сегментация аудитории повышает конверсию.",
  tags: ["marketing", "conversion"],
};

describe("[dataset-export] conceptToShareGPT", () => {
  test("1 pair = 1 ShareGPT line with system+human+gpt", () => {
    const lines = conceptToShareGPT(BASE_CONCEPT, 1);
    assert.equal(lines.length, 1);
    const conv = lines[0]!.conversations;
    assert.equal(conv.length, 3);
    assert.equal(conv[0]!.from, "system");
    assert.equal(conv[1]!.from, "human");
    assert.equal(conv[2]!.from, "gpt");
    assert.ok(conv[0]!.value.includes("маркетинг"));
    assert.ok(conv[2]!.value.includes("Сегментация"));
  });

  test("2 pairs = 2 lines with increasing depth", () => {
    const concept = {
      ...BASE_CONCEPT,
      proof: "Исследование McKinsey 2024 показало рост на 30%.",
    };
    const lines = conceptToShareGPT(concept, 2);
    assert.equal(lines.length, 2);

    const answer1 = lines[0]!.conversations[2]!.value;
    const answer2 = lines[1]!.conversations[2]!.value;

    assert.ok(answer1.includes("Сегментация"));
    assert.ok(answer2.includes("McKinsey"), "second answer should include proof");
    assert.ok(answer2.length > answer1.length, "deeper answers should be longer");
  });

  test("3 pairs with applicability", () => {
    const concept = {
      ...BASE_CONCEPT,
      proof: "Доказано A/B тестами.",
      applicability: "Применяется в email-маркетинге и таргетинге.",
    };
    const lines = conceptToShareGPT(concept, 3);
    assert.equal(lines.length, 3);

    const answer3 = lines[2]!.conversations[2]!.value;
    assert.ok(answer3.includes("Применяется"), "third answer should include applicability");
  });

  test("meta contains concept_id and domain", () => {
    const lines = conceptToShareGPT(BASE_CONCEPT, 1);
    const meta = lines[0]!.meta as Record<string, unknown>;
    assert.equal(meta.concept_id, "c-001");
    assert.equal(meta.domain, "маркетинг");
    assert.deepEqual(meta.tags, ["marketing", "conversion"]);
    assert.equal(meta.depth, 1);
  });

  test("cipher used when no proof", () => {
    const concept = {
      ...BASE_CONCEPT,
      cipher: "CTR = clicks / impressions",
    };
    const lines = conceptToShareGPT(concept, 2);
    const answer2 = lines[1]!.conversations[2]!.value;
    assert.ok(answer2.includes("CTR"), "should use cipher when proof is absent");
  });

  test("pairs clamped to [1, 5]", () => {
    const lines0 = conceptToShareGPT(BASE_CONCEPT, 0);
    assert.equal(lines0.length, 1, "min 1 pair");

    const lines10 = conceptToShareGPT(BASE_CONCEPT, 10);
    assert.equal(lines10.length, 5, "max 5 pairs");
  });

  test("different question variants for each depth", () => {
    const lines = conceptToShareGPT(BASE_CONCEPT, 3);
    const questions = lines.map((l) => l.conversations[1]!.value);
    const unique = new Set(questions);
    assert.equal(unique.size, 3, "each depth should use a different question");
  });

  test("empty tags handled gracefully", () => {
    const concept = { id: "c-002", domain: "ux", essence: "Test.", tags: [] };
    const lines = conceptToShareGPT(concept, 1);
    assert.equal(lines.length, 1);
    const meta = lines[0]!.meta as Record<string, unknown>;
    assert.deepEqual(meta.tags, []);
  });
});
