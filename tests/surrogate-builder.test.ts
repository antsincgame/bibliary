/**
 * Unit tests for electron/lib/library/surrogate-builder.ts
 *
 * Phase 12 contract: deterministic surrogate from a fixture book.
 * Asserts:
 *   - TOC count
 *   - intro / outro length within target window
 *   - 3-5 nodal chapters picked, excluding first/last
 *   - small books bypass distillation (full text mode)
 *   - empty book yields empty surrogate without throw
 *   - oversized paragraph compaction (we never let OCR mega-paragraphs blow context)
 *
 * Запуск: `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSurrogate } from "../electron/lib/library/surrogate-builder.ts";
import type { ConvertedChapter } from "../electron/lib/library/types.ts";

/** Generate a paragraph of `n` repeated lorem-ipsum-ish words. */
function paragraph(n: number, marker = "lorem"): string {
  return Array.from({ length: n }, (_, i) => `${marker}${i}`).join(" ");
}

function chapter(index: number, title: string, paraSizes: number[]): ConvertedChapter {
  const paragraphs = paraSizes.map((n, i) => paragraph(n, `ch${index}p${i}`));
  const wordCount = paraSizes.reduce((s, n) => s + n, 0);
  return { index, title, paragraphs, wordCount };
}

test("[1] empty array → empty surrogate marker, no throw", () => {
  const r = buildSurrogate([]);
  assert.equal(r.surrogate, "[empty book]");
  assert.equal(r.composition.totalWords, 0);
  assert.equal(r.composition.tocChapters, 0);
});

test("[2] single chapter with 0 words → empty marker", () => {
  const ch: ConvertedChapter = { index: 0, title: "Empty", paragraphs: [], wordCount: 0 };
  const r = buildSurrogate([ch]);
  assert.equal(r.surrogate, "[empty book]");
});

test("[3] tiny book (under 3000 words) → full-text mode (no distillation)", () => {
  /* 3 chapters × 200 words = 600 words total. Under threshold of 1.5x(1000+1000)=3000. */
  const chapters = [
    chapter(0, "Chapter One", [200]),
    chapter(1, "Chapter Two", [200]),
    chapter(2, "Chapter Three", [200]),
  ];
  const r = buildSurrogate(chapters);
  assert.ok(r.surrogate.includes("Full Text (book is too small for distillation)"));
  assert.ok(r.surrogate.includes("Chapter One"));
  assert.ok(r.surrogate.includes("Chapter Two"));
  assert.ok(r.surrogate.includes("Chapter Three"));
  assert.equal(r.composition.tocChapters, 3);
  assert.equal(r.composition.totalWords, 600);
  assert.equal(r.composition.nodalSlices.length, 0);
});

test("[4] full-size book → produces distilled surrogate with all sections", () => {
  /* 10 chapters: intro 1500w, outro 1500w, middle chapters at 800-2500 words. */
  const chapters: ConvertedChapter[] = [
    chapter(0, "Introduction", [1500]),                     /* will become intro */
    chapter(1, "Foundations",  [400, 600, 800]),            /* 1800w */
    chapter(2, "Methodology",  [500, 700, 800, 500]),       /* 2500w — should be nodal */
    chapter(3, "Case Studies", [300, 400]),                 /* 700w  — too small probably */
    chapter(4, "Advanced",     [600, 800, 1000]),           /* 2400w — should be nodal */
    chapter(5, "Patterns",     [500, 500, 500]),            /* 1500w */
    chapter(6, "Anti-patterns",[700, 700, 700]),            /* 2100w — should be nodal */
    chapter(7, "Tools",        [400, 600]),                 /* 1000w */
    chapter(8, "Future",       [500, 500]),                 /* 1000w */
    chapter(9, "Conclusion",   [1500]),                     /* will become outro */
  ];

  const r = buildSurrogate(chapters);

  /* All four surrogate sections present. */
  assert.ok(r.surrogate.includes("# Table of Contents"));
  assert.ok(r.surrogate.includes("# Introduction (first ~1000 words)"));
  assert.ok(r.surrogate.includes("# Conclusion (last ~1000 words)"));
  assert.ok(r.surrogate.includes("# Nodal Slices"));

  /* TOC must list every chapter with its title. */
  for (const ch of chapters) assert.ok(r.surrogate.includes(ch.title), `TOC missing: ${ch.title}`);

  /* Composition counts. */
  assert.equal(r.composition.tocChapters, 10);
  assert.ok(r.composition.introWords >= 1000, `intro too small: ${r.composition.introWords}`);
  assert.ok(r.composition.outroWords >= 1000, `outro too small: ${r.composition.outroWords}`);
  assert.ok(r.composition.nodalSlices.length >= 3 && r.composition.nodalSlices.length <= 5,
    `nodal count out of range: ${r.composition.nodalSlices.length}`);

  /* Nodal slices must NOT include first or last chapter (those are intro/outro). */
  const nodalTitles = r.composition.nodalSlices.map((n) => n.chapter);
  assert.ok(!nodalTitles.includes("Introduction"), "intro chapter must not be nodal");
  assert.ok(!nodalTitles.includes("Conclusion"), "outro chapter must not be nodal");
});

test("[5] oversized paragraph compaction: intro is bounded and not sliced mid-word", () => {
  /* OCR/PDF parsers sometimes emit one huge paragraph. The surrogate must cap it
     to keep LM Studio inside context while still slicing on word boundaries. */
  const chapters = [
    chapter(0, "Mega Intro", [1500]),
    ...Array.from({ length: 8 }, (_, i) => chapter(i + 1, `Filler ${i + 1}`, [500])),
    chapter(9, "Outro", [1200]),
  ];
  const r = buildSurrogate(chapters);
  assert.equal(r.composition.introWords, 1000);
  assert.ok(r.surrogate.includes("ch0p0999"), "last kept word should be complete");
  assert.ok(!r.surrogate.includes("ch0p01000"), "oversized paragraph must be capped at target");
});

test("[6] only 2 chapters → no nodal slices (intro+outro covers everything)", () => {
  const chapters = [chapter(0, "Intro", [1500]), chapter(1, "Outro", [1500])];
  const r = buildSurrogate(chapters);
  assert.equal(r.composition.nodalSlices.length, 0);
});

test("[7] surrogate compression ratio: massive book → bounded surrogate", () => {
  /* 50 chapters × (2500 + 1500 + 1000) = 250,000 words. OCR mega-paragraphs
     must be capped, so the surrogate stays comfortably below context limits. */
  const chapters: ConvertedChapter[] = Array.from({ length: 50 }, (_, i) =>
    chapter(i, `Chapter ${i + 1}`, [2500, 1500, 1000]),
  );
  const r = buildSurrogate(chapters);
  const totalSource = chapters.reduce((s, ch) => s + ch.wordCount, 0);
  const ratio = r.composition.totalWords / totalSource;
  assert.ok(ratio < 0.15,
    `compression too weak: ${r.composition.totalWords} / ${totalSource} = ${(ratio * 100).toFixed(1)}%`);
  assert.equal(r.composition.tocChapters, 50);
});

test("[8] empty paragraphs are filtered (no blank-line garbage in nodal slices)", () => {
  const chapters: ConvertedChapter[] = [
    chapter(0, "Intro", [1500]),
    {
      index: 1,
      title: "Chapter With Blanks",
      paragraphs: ["", "  ", paragraph(800, "real0"), "  ", paragraph(800, "real1"), "", ""],
      wordCount: 1600,
    },
    chapter(2, "Filler A", [500]),
    chapter(3, "Filler B", [500]),
    chapter(4, "Filler C", [500]),
    chapter(5, "Outro", [1500]),
  ];
  const r = buildSurrogate(chapters);
  /* The nodal slice for "Chapter With Blanks" must NOT contain double-blank lines. */
  const blanksChunk = r.composition.nodalSlices.find((n) => n.chapter === "Chapter With Blanks");
  if (blanksChunk) {
    assert.ok(blanksChunk.paragraphs <= 2, `expected ≤2 paragraphs, got ${blanksChunk.paragraphs}`);
    assert.ok(blanksChunk.words >= 500 && blanksChunk.words <= 520,
      `nodal slice should contain compacted real text, got ${blanksChunk.words} words`);
  }
});

test("[9] chapter without title falls back to 'Chapter N'", () => {
  const chapters: ConvertedChapter[] = [
    { index: 0, title: "", paragraphs: [paragraph(1500, "introA")], wordCount: 1500 },
    { index: 1, title: "  ", paragraphs: [paragraph(500, "midA")], wordCount: 500 },
    { index: 2, title: "Outro", paragraphs: [paragraph(1500, "outroA")], wordCount: 1500 },
  ];
  const r = buildSurrogate(chapters);
  assert.ok(r.surrogate.includes("Chapter 1"), "missing title fallback");
});
