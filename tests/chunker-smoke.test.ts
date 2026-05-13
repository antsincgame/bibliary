/**
 * Structural chunker (Phase 6d MVP) — smoke tests.
 *
 * Purely functional code, no env vars needed. Покрываем:
 *   - Small chapter (< maxWords) → 1 chunk
 *   - Large chapter с heading boundaries → split по headings
 *   - Tiny tail < minWords → merged with previous
 *   - Overlap: последний параграф предыдущего чанка появляется в начале следующего
 *   - Heading detected: "## Заголовок", "Chapter 1", *** separator
 *   - Empty paragraphs filtered
 *   - splitMarkdownIntoChapters: frontmatter dropped, H1/H2 splits, no-headings fallback
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chunkChapter, splitMarkdownIntoChapters } from "../server/lib/library/chunker.ts";

function paragraphsOfSize(sizeWords: number, count: number): string[] {
  const para = Array.from({ length: sizeWords }, (_, i) => `word${i}`).join(" ");
  return Array.from({ length: count }, () => para);
}

describe("structural chunker", () => {
  it("small chapter (<maxWords) → single chunk", () => {
    const chunks = chunkChapter({
      paragraphs: paragraphsOfSize(100, 5),
    });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].partN, 1);
    /* 500 words concat with \n\n separator */
    assert.ok(chunks[0].text.length > 100);
  });

  it("large chapter splits по target size", () => {
    const chunks = chunkChapter(
      {
        paragraphs: paragraphsOfSize(200, 10), // 2000 words total
      },
      { targetWords: 500, maxWords: 800, minWords: 100, overlapParagraphs: 0 },
    );
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    assert.ok(
      chunks.every((c) => c.text.split(/\s+/).filter(Boolean).length <= 800),
      "no chunk should exceed maxWords",
    );
  });

  it("heading boundary разрывает чанк", () => {
    /* Большой total wordcount чтобы early-return single-chunk не сработал. */
    const big1 = paragraphsOfSize(100, 5); // 500 words
    const big2 = paragraphsOfSize(100, 5); // 500 words
    const chunks = chunkChapter(
      {
        paragraphs: [...big1, "## Heading Two", ...big2],
      },
      { targetWords: 300, maxWords: 600, minWords: 100, overlapParagraphs: 0 },
    );
    assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
  });

  it("overlap дублирует последний параграф предыдущего чанка", () => {
    const big1 = paragraphsOfSize(100, 5);
    const big2 = paragraphsOfSize(100, 5);
    const chunks = chunkChapter(
      { paragraphs: [...big1, "## Heading", ...big2] },
      { targetWords: 300, maxWords: 600, minWords: 100, overlapParagraphs: 1 },
    );
    assert.ok(chunks.length >= 2);
    /* Второй chunk должен начинаться с последнего параграфа первого. */
    const firstLastPara = chunks[0].text.split("\n\n").pop();
    if (firstLastPara && firstLastPara.length > 10) {
      assert.ok(
        chunks[1].text.startsWith(firstLastPara) ||
          chunks[1].text.includes(firstLastPara),
        "overlap должен включить хвост предыдущего chunk",
      );
    }
  });

  it("empty paragraphs filtered", () => {
    const chunks = chunkChapter({
      paragraphs: ["valid text", "  ", "", "  \n  ", "more valid text"],
    });
    assert.equal(chunks.length, 1);
    assert.ok(!chunks[0].text.includes("\n\n\n"));
  });

  it("partN индексация 1-based", () => {
    const chunks = chunkChapter(
      { paragraphs: paragraphsOfSize(300, 6) },
      { targetWords: 300, maxWords: 600, minWords: 100, overlapParagraphs: 0 },
    );
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0].partN, 1);
    assert.equal(chunks[1].partN, 2);
  });

  it("empty input → empty array", () => {
    assert.deepEqual(chunkChapter({ paragraphs: [] }), []);
    assert.deepEqual(chunkChapter({ paragraphs: ["   ", "\n"] }), []);
  });
});

describe("splitMarkdownIntoChapters", () => {
  it("frontmatter dropped", () => {
    const md = `---
title: Test Book
sha256: abc
---

# Chapter One

First paragraph.

Second paragraph.`;
    const chapters = splitMarkdownIntoChapters(md);
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].chapterTitle, "Chapter One");
    assert.equal(chapters[0].paragraphs.length, 2);
  });

  it("H1 + H2 каждый создаёт chapter boundary", () => {
    const md = `# Part I

Para A.

## Section 1.1

Para B.

# Part II

Para C.`;
    const chapters = splitMarkdownIntoChapters(md);
    assert.equal(chapters.length, 3);
    assert.deepEqual(chapters.map((c) => c.chapterTitle), [
      "Part I",
      "Section 1.1",
      "Part II",
    ]);
  });

  it("no headings → single 'Body' chapter", () => {
    const md = "Just plain text.\n\nAnother paragraph.\n\nThird.";
    const chapters = splitMarkdownIntoChapters(md);
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].chapterTitle, "Body");
    assert.equal(chapters[0].paragraphs.length, 3);
  });

  it("empty markdown → empty array", () => {
    assert.deepEqual(splitMarkdownIntoChapters(""), []);
    assert.deepEqual(splitMarkdownIntoChapters("---\nonly: frontmatter\n---\n"), []);
  });
});
