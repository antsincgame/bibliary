/**
 * Phase 8e — chunk-cleanup + token-budget pure smoke tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cleanChapterParagraphs,
  cleanRawText,
} from "../server/lib/library/chunk-cleanup.ts";
import {
  approxTokenCount,
  trimToTokenBudget,
} from "../server/lib/library/token-budget.ts";

describe("cleanChapterParagraphs — metadata stripping", () => {
  it("strips standalone page markers", () => {
    const out = cleanChapterParagraphs([
      "Real content paragraph with actual knowledge here.",
      "— 47 —",
      "[123]",
      "Page 200",
      "стр. 88",
      "Second real paragraph with information.",
    ]);
    assert.equal(out.length, 2);
    assert.ok(out[0].includes("Real content"));
    assert.ok(out[1].includes("Second real"));
  });

  it("strips ISBN / copyright lines", () => {
    const out = cleanChapterParagraphs([
      "© 2015 John Doe Publishing",
      "ISBN 978-0-321-56384-2",
      "All rights reserved",
      "Printed in the United States of America",
      "Все права защищены",
      "Actual paragraph with knowledge content here.",
    ]);
    assert.equal(out.length, 1);
    assert.ok(out[0].includes("Actual paragraph"));
  });

  it("strips decorative dividers and 'end of chapter'", () => {
    const out = cleanChapterParagraphs([
      "* * *",
      "———",
      "End of chapter",
      "Конец главы",
      "Substantive content paragraph here.",
    ]);
    assert.equal(out.length, 1);
  });

  it("strips footnote markers but preserves the text", () => {
    const out = cleanChapterParagraphs([
      "This paragraph contains a footnote reference [1]",
      "Another paragraph with marker †",
      "Plain paragraph with no marker.",
    ]);
    assert.equal(out.length, 3);
    assert.ok(!out[0].endsWith("[1]"));
    assert.ok(!out[1].endsWith("†"));
  });

  it("removes running headers/footers (repeated short lines)", () => {
    const paragraphs = [
      "Chapter 5 — Cognitive Load Theory",
      "Body content about working memory.",
      "Chapter 5 — Cognitive Load Theory",
      "More body content about schemas.",
      "Chapter 5 — Cognitive Load Theory",
      "Final body content with conclusions.",
    ];
    const out = cleanChapterParagraphs(paragraphs);
    /* Repeated header (×3) should be dropped, body content stays. */
    assert.equal(out.length, 3);
    assert.ok(out.every((p) => p.startsWith("Body") || p.startsWith("More") || p.startsWith("Final")));
  });

  it("does NOT strip when short-line repeats < threshold", () => {
    const out = cleanChapterParagraphs([
      "Short note",
      "Long content paragraph one with real information here.",
      "Short note",
      "Long content paragraph two with real information.",
    ]);
    /* Repeated only 2× < default threshold 3 → stays. */
    assert.equal(out.length, 4);
  });

  it("opt-out individual passes", () => {
    const out = cleanChapterParagraphs(
      ["ISBN 978-0-321", "Body content here."],
      { stripBoilerplate: false },
    );
    assert.equal(out.length, 2);
  });

  it("cleanRawText joins paragraphs back with double-newline", () => {
    const text = "© 2020 Author\n\nReal content\n\nMore content\n\n— 1 —";
    const out = cleanRawText(text);
    assert.equal(out.split("\n\n").length, 2);
    assert.ok(!out.includes("©"));
    assert.ok(!out.includes("— 1 —"));
  });
});

describe("approxTokenCount + trimToTokenBudget", () => {
  it("ASCII ~4 chars per token", () => {
    const text = "x".repeat(400); // pure ASCII, 100 tokens approx
    const count = approxTokenCount(text);
    assert.ok(count >= 90 && count <= 110, `expected ~100, got ${count}`);
  });

  it("Cyrillic counts higher than ASCII at same char count", () => {
    const cyrillic = "т".repeat(400);
    const ascii = "x".repeat(400);
    assert.ok(approxTokenCount(cyrillic) > approxTokenCount(ascii));
  });

  it("Empty string → 0 tokens", () => {
    assert.equal(approxTokenCount(""), 0);
  });

  it("trimToTokenBudget returns unchanged when under budget", () => {
    const text = "Short paragraph fits easily.";
    const { text: out, trimmed } = trimToTokenBudget(text, 1000);
    assert.equal(out, text);
    assert.equal(trimmed, false);
  });

  it("trimToTokenBudget cuts at sentence boundary when over budget", () => {
    const text = "First sentence here. Second sentence here. Third sentence here. " + "more content. ".repeat(200);
    const { text: out, trimmed } = trimToTokenBudget(text, 50);
    assert.equal(trimmed, true);
    assert.ok(out.length < text.length);
    /* Prefer to end at sentence boundary */
    assert.ok(out.endsWith(".") || out.endsWith("…"));
  });

  it("trimToTokenBudget originalTokens reflects pre-trim size", () => {
    const text = "x".repeat(4000);
    const { originalTokens, trimmed } = trimToTokenBudget(text, 100);
    assert.ok(originalTokens >= 900);
    assert.equal(trimmed, true);
  });
});
