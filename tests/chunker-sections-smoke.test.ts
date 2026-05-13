/**
 * Phase Δa — section-aware chunker smoke. Verifies that:
 *   - splitMarkdownIntoSections preserves H1/H2/H3/.. hierarchy via pathTitles
 *   - level 0 captures pre-heading body
 *   - chunkSections never merges text across a heading boundary
 *   - section.order is monotonic in document order
 *   - back-compat splitMarkdownIntoChapters still flattens to H1/H2 only
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  chunkSections,
  splitMarkdownIntoChapters,
  splitMarkdownIntoSections,
} from "../server/lib/library/chunker.ts";

describe("splitMarkdownIntoSections", () => {
  it("hierarchy: H1 > H2 > H3 path captured in pathTitles", () => {
    const md = `# Part I

Lead para.

## Chapter 1

Body of ch1.

### Section 1.1

Body of 1.1.

### Section 1.2

Body of 1.2.

## Chapter 2

Body of ch2.

# Part II

Final.`;
    const sections = splitMarkdownIntoSections(md);
    /* 6 sections: Part I, Ch1, S1.1, S1.2, Ch2, Part II */
    assert.equal(sections.length, 6);

    const titles = sections.map((s) => s.title);
    assert.deepEqual(titles, [
      "Part I",
      "Chapter 1",
      "Section 1.1",
      "Section 1.2",
      "Chapter 2",
      "Part II",
    ]);

    const levels = sections.map((s) => s.level);
    assert.deepEqual(levels, [1, 2, 3, 3, 2, 1]);

    /* Section 1.1 breadcrumb should be ["Part I", "Chapter 1", "Section 1.1"] */
    const s11 = sections.find((s) => s.title === "Section 1.1");
    assert.ok(s11);
    assert.deepEqual(s11.pathTitles, ["Part I", "Chapter 1", "Section 1.1"]);

    /* Chapter 2 should reset the H3 stack — its pathTitles must NOT contain Section 1.2. */
    const ch2 = sections.find((s) => s.title === "Chapter 2");
    assert.ok(ch2);
    assert.deepEqual(ch2.pathTitles, ["Part I", "Chapter 2"]);

    /* Part II should reset to depth 1 — no leftover Part I in the path. */
    const partII = sections.find((s) => s.title === "Part II");
    assert.ok(partII);
    assert.deepEqual(partII.pathTitles, ["Part II"]);
  });

  it("preface (text before first heading) becomes level=0 section", () => {
    const md = `Foreword paragraph one.

Foreword paragraph two.

# Chapter One

Body.`;
    const sections = splitMarkdownIntoSections(md);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].level, 0);
    assert.equal(sections[0].title, "");
    assert.deepEqual(sections[0].pathTitles, []);
    assert.equal(sections[0].paragraphs.length, 2);
    assert.equal(sections[1].title, "Chapter One");
  });

  it("section.order is monotonic in document order, starting at 1", () => {
    const md = `# A

a.

# B

b.

# C

c.`;
    const sections = splitMarkdownIntoSections(md);
    assert.deepEqual(
      sections.map((s) => s.order),
      [1, 2, 3],
    );
  });

  it("no headings → single level-0 body section", () => {
    const sections = splitMarkdownIntoSections("just text.\n\nmore text.");
    assert.equal(sections.length, 1);
    assert.equal(sections[0].level, 0);
    assert.equal(sections[0].paragraphs.length, 2);
  });

  it("frontmatter dropped", () => {
    const md = `---
title: X
---

# Real heading

body.`;
    const sections = splitMarkdownIntoSections(md);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].title, "Real heading");
  });
});

describe("chunkSections", () => {
  it("never merges text across a heading boundary", () => {
    const a = Array.from({ length: 5 }, (_, i) => `alpha paragraph ${i}`);
    const b = Array.from({ length: 5 }, (_, i) => `beta paragraph ${i}`);
    const sections = [
      {
        level: 1 as const,
        title: "A",
        pathTitles: ["A"],
        order: 1,
        paragraphs: a,
      },
      {
        level: 1 as const,
        title: "B",
        pathTitles: ["B"],
        order: 2,
        paragraphs: b,
      },
    ];
    const chunks = chunkSections(sections);
    /* Each chunk must belong to exactly one section. */
    for (const c of chunks) {
      const hasAlpha = c.text.includes("alpha");
      const hasBeta = c.text.includes("beta");
      assert.ok(!(hasAlpha && hasBeta), "chunk leaked across heading boundary");
    }
  });

  it("propagates pathTitles + sectionOrder to every emitted chunk", () => {
    const sections = [
      {
        level: 2 as const,
        title: "Sec",
        pathTitles: ["Part", "Sec"],
        order: 7,
        paragraphs: ["one paragraph only"],
      },
    ];
    const chunks = chunkSections(sections);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].pathTitles, ["Part", "Sec"]);
    assert.equal(chunks[0].sectionLevel, 2);
    assert.equal(chunks[0].sectionOrder, 7);
    assert.equal(chunks[0].partN, 1);
    assert.equal(chunks[0].partOf, 1);
  });

  it("partOf reflects how many chunks the section produced", () => {
    /* Force a multi-chunk split with tight word budget. */
    const paragraphs = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 200 }, (_, j) => `w${i}_${j}`).join(" "),
    );
    const chunks = chunkSections(
      [
        {
          level: 1,
          title: "Big",
          pathTitles: ["Big"],
          order: 1,
          paragraphs,
        },
      ],
      { targetWords: 300, maxWords: 600, minWords: 100, overlapParagraphs: 0 },
    );
    assert.ok(chunks.length >= 2);
    for (const c of chunks) {
      assert.equal(c.partOf, chunks.length);
    }
    assert.deepEqual(
      chunks.map((c) => c.partN),
      Array.from({ length: chunks.length }, (_, i) => i + 1),
    );
  });

  it("skips empty sections", () => {
    const chunks = chunkSections([
      {
        level: 1,
        title: "Empty",
        pathTitles: ["Empty"],
        order: 1,
        paragraphs: [],
      },
      {
        level: 1,
        title: "Has Text",
        pathTitles: ["Has Text"],
        order: 2,
        paragraphs: ["real content here"],
      },
    ]);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].pathTitles, ["Has Text"]);
  });
});

describe("splitMarkdownIntoChapters (back-compat after Δa rewire)", () => {
  it("H3+ folded into parent H1/H2 chapter as inline heading lines", () => {
    const md = `# Part I

Intro.

## Chapter 1

Body.

### Subsection A

Sub body.

## Chapter 2

Body 2.`;
    const chapters = splitMarkdownIntoChapters(md);
    /* 3 chapters: Part I, Chapter 1, Chapter 2.  Subsection A is folded into Chapter 1. */
    assert.equal(chapters.length, 3);
    assert.deepEqual(
      chapters.map((c) => c.chapterTitle),
      ["Part I", "Chapter 1", "Chapter 2"],
    );
    const ch1 = chapters[1];
    /* Folded subsection title appears as a paragraph the chunker can split on. */
    assert.ok(ch1.paragraphs.some((p) => p.includes("Subsection A")));
    assert.ok(ch1.paragraphs.some((p) => p.includes("Sub body")));
  });

  it("legacy: still single 'Body' for no-heading markdown", () => {
    const chapters = splitMarkdownIntoChapters("plain.\n\ntext.");
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].chapterTitle, "Body");
  });
});
