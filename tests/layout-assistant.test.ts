/**
 * Layout Assistant unit tests.
 *
 * Three groups (см. план, секция CRITICAL RISKS):
 *   1. applyLayoutAnnotations — bottom-up patching, line drift, idempotency
 *   2. safeParseAnnotations   — JSON resilience (jsonrepair + partial regex)
 *   3. chunkMarkdown          — paragraph-boundary chunking with overlap
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  safeParseAnnotations,
  extractJsonSubstring,
  extractPartialAnnotations,
  LayoutAnnotationsSchema,
  LAYOUT_ASSISTANT_MARKER,
  LAYOUT_EMPTY_SCAFFOLD,
  type LayoutAnnotations,
} from "../electron/lib/library/layout-assistant-schema.ts";
import {
  applyLayoutAnnotations,
  chunkMarkdown,
  mergeAnnotations,
} from "../electron/lib/library/layout-assistant.ts";

/* ─── Group 1: applyLayoutAnnotations ──────────────────────────────────── */

describe("applyLayoutAnnotations: bottom-up patching", () => {
  test("missing heading marker → promotes to ##", () => {
    const md = "Chapter 1: The Manifest\n\nThis is text";
    const ann: LayoutAnnotations = {
      headings: [{ line: 1, level: 2, text: "Chapter 1: The Manifest" }],
      toc_block: null,
      junk_lines: [],
    };
    const out = applyLayoutAnnotations(md, ann);
    assert.match(out, /## Chapter 1: The Manifest\n\nThis is text/);
    assert.ok(out.includes(LAYOUT_ASSISTANT_MARKER), "marker added");
  });

  test("wrong heading level → corrected", () => {
    const md = "### A Tour of C++\n\n#### C++ In-Depth Series";
    const ann: LayoutAnnotations = {
      headings: [
        { line: 1, level: 1, text: "A Tour of C++" },
        { line: 3, level: 2, text: "C++ In-Depth Series" },
      ],
      toc_block: null,
      junk_lines: [],
    };
    const out = applyLayoutAnnotations(md, ann);
    assert.match(out, /# A Tour of C\+\+/);
    assert.match(out, /## C\+\+ In-Depth Series/);
    assert.ok(!out.includes("###"), "no ### remains");
  });

  test("OCR junk (page numbers) → removed", () => {
    const md = "text\n\n17\n\nmore text";
    const ann: LayoutAnnotations = {
      headings: [],
      toc_block: null,
      junk_lines: [3],
    };
    const out = applyLayoutAnnotations(md, ann);
    assert.ok(!out.match(/^17$/m), "junk line removed");
    assert.ok(out.includes("text"));
    assert.ok(out.includes("more text"));
  });

  test("idempotency: skips when marker present", () => {
    const md = `---\n${LAYOUT_ASSISTANT_MARKER}\n---\nbody`;
    const ann: LayoutAnnotations = {
      headings: [{ line: 4, level: 2, text: "body" }],
      toc_block: null,
      junk_lines: [],
    };
    const out = applyLayoutAnnotations(md, ann);
    assert.equal(out, md, "input unchanged when marker present");
  });

  test("empty annotations → adds marker only", () => {
    const md = "valid markdown\n\nwith two paragraphs";
    const ann: LayoutAnnotations = { headings: [], toc_block: null, junk_lines: [] };
    const out = applyLayoutAnnotations(md, ann);
    assert.ok(out.includes(LAYOUT_ASSISTANT_MARKER), "marker added");
    assert.ok(out.includes("valid markdown"));
    assert.ok(out.includes("with two paragraphs"));
  });

  test("Cyrillic headings supported", () => {
    const md = "Глава 3. Методы\n\nТекст параграфа";
    const ann: LayoutAnnotations = {
      headings: [{ line: 1, level: 2, text: "Глава 3. Методы" }],
      toc_block: null,
      junk_lines: [],
    };
    const out = applyLayoutAnnotations(md, ann);
    assert.match(out, /## Глава 3\. Методы/);
  });

  /** Risk 1 fix verification: junk_lines BEFORE a heading must not shift the
   *  heading's target line during bottom-up application. */
  test("Bug 9: hallucinated heading text is skipped, original line preserved", () => {
    const md = "Real chapter title\n\nbody text here";
    const ann: LayoutAnnotations = {
      headings: [{ line: 1, level: 2, text: "COMPLETELY MADE UP TITLE BY MODEL" }],
      toc_block: null,
      junk_lines: [],
    };
    const out = applyLayoutAnnotations(md, ann);
    assert.ok(!out.includes("## COMPLETELY MADE UP TITLE"), "hallucinated heading rejected");
    assert.ok(out.includes("Real chapter title"), "original line preserved");
  });

  test("Bug 9: partial match heading text IS accepted", () => {
    const md = "Chapter 1: Introduction to Arrays\n\nbody";
    const ann: LayoutAnnotations = {
      headings: [{ line: 1, level: 2, text: "Chapter 1: Introduction" }],
      toc_block: null,
      junk_lines: [],
    };
    const out = applyLayoutAnnotations(md, ann);
    assert.ok(out.includes("## Chapter 1: Introduction to Arrays"), "partial match heading accepted (original text preserved)");
  });

  test("Risk 1: line drift — junk before heading does NOT shift heading target", () => {
    /* Lines (1-indexed):
       1: text
       2: (blank)
       3: 42       ← junk to remove
       4: (blank)
       5: Chapter 2 ← heading target
       6: (blank)
       7: body */
    const md = "text\n\n42\n\nChapter 2\n\nbody";
    const ann: LayoutAnnotations = {
      headings: [{ line: 5, level: 2, text: "Chapter 2" }],
      toc_block: null,
      junk_lines: [3],
    };
    const out = applyLayoutAnnotations(md, ann);
    /* After bottom-up: heading replaced FIRST (line 5 → "## Chapter 2"),
       then junk removed (line 3 → empty array element).
       The result must contain "## Chapter 2" on the correct line and NOT
       have "## body" or "## 42" (which would be line drift symptoms). */
    assert.ok(out.includes("## Chapter 2"), "heading promoted");
    assert.ok(!out.match(/^42$/m), "junk removed");
    assert.ok(out.includes("body"), "body intact");
    assert.ok(!out.includes("## body"), "no line drift: body NOT promoted");
    assert.ok(!out.includes("## 42"), "no line drift: junk NOT promoted");
  });
});

/* ─── Group 2: safeParseAnnotations — JSON resilience ──────────────────── */

describe("safeParseAnnotations: JSON resilience (Risk 3 fix)", () => {
  test("valid JSON → parsed", () => {
    const raw = JSON.stringify({
      headings: [{ line: 5, level: 2, text: "Intro" }],
      toc_block: null,
      junk_lines: [10, 12],
    });
    const out = safeParseAnnotations(raw);
    assert.ok(out, "parse succeeded");
    assert.equal(out!.headings.length, 1);
    assert.deepEqual(out!.junk_lines, [10, 12]);
  });

  test("truncated JSON (missing closing brace) → repaired", () => {
    const raw = '{"headings":[{"line":1,"level":2,"text":"Ch1"}],"junk_lines":[';
    const out = safeParseAnnotations(raw);
    assert.ok(out, "jsonrepair recovered partial output");
    assert.equal(out!.headings.length, 1);
    assert.equal(out!.headings[0].text, "Ch1");
  });

  test("trailing comma → repaired", () => {
    const raw = '{"headings":[],"junk_lines":[10,12,],"toc_block":null,}';
    const out = safeParseAnnotations(raw);
    assert.ok(out, "trailing commas repaired");
    assert.deepEqual(out!.junk_lines, [10, 12]);
  });

  test("plain text, no JSON → null (no crash)", () => {
    const raw = "Here are the headings: none found.";
    const out = safeParseAnnotations(raw);
    assert.equal(out, null);
  });

  test("JSON with preamble text → extracts substring", () => {
    const raw = 'Here is the JSON:\n{"headings":[],"toc_block":null,"junk_lines":[]}';
    const out = safeParseAnnotations(raw);
    assert.ok(out, "preamble stripped");
    assert.equal(out!.headings.length, 0);
  });

  test("partial regex fallback: headings only, rest broken", () => {
    /* jsonrepair will fail on this — fallback regex extracts headings. */
    const raw = '{"headings":[{"line":5,"level":2,"text":"Chapter 1"}], "junk_li';
    const out = safeParseAnnotations(raw);
    /* Either jsonrepair fixes it or partial regex catches headings. */
    assert.ok(out, "some recovery path succeeded");
    assert.ok(out!.headings.length >= 1, "heading recovered");
    assert.equal(out!.headings[0].text, "Chapter 1");
  });

  test("empty string → null", () => {
    assert.equal(safeParseAnnotations(""), null);
    assert.equal(safeParseAnnotations("   \n  "), null);
  });

  test("extractJsonSubstring: finds balanced braces", () => {
    assert.equal(extractJsonSubstring('prefix {"a":1} suffix'), '{"a":1}');
    assert.equal(extractJsonSubstring('xx {"a":{"b":2}} yy'), '{"a":{"b":2}}');
    assert.equal(extractJsonSubstring("no json here"), null);
  });

  test("extractPartialAnnotations: catches headings in broken JSON", () => {
    const raw = 'garbage "line": 7, "level": 1, "text": "Foo"';
    const out = extractPartialAnnotations(raw);
    assert.ok(out, "partial extraction succeeded");
    assert.equal(out!.headings.length, 1);
    assert.equal(out!.headings[0].text, "Foo");
  });

  test("LAYOUT_EMPTY_SCAFFOLD parses through schema cleanly", () => {
    const out = LayoutAnnotationsSchema.parse(JSON.parse(LAYOUT_EMPTY_SCAFFOLD));
    assert.deepEqual(out, { headings: [], junk_lines: [] });
  });
});

/* ─── Group 3: chunkMarkdown — paragraph-boundary chunking (Risk 2) ────── */

describe("chunkMarkdown: paragraph-boundary chunking (Risk 2 fix)", () => {
  test("short doc fits in single chunk", () => {
    const md = "para 1\n\npara 2\n\npara 3";
    const chunks = chunkMarkdown(md, 1000, 100);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].lineOffset, 0);
    assert.equal(chunks[0].text, md);
  });

  test("Bug 12: single huge paragraph > maxChars is split into multiple chunks", () => {
    /* A single paragraph without any \n\n: should be char-split. */
    const hugeBlock = "A".repeat(5000);
    const chunks = chunkMarkdown(hugeBlock, 1000, 0);
    assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
    /* No chunk should be > maxChars (allows small overshoot only on line boundaries). */
    for (const ch of chunks) {
      assert.ok(ch.text.length <= 1500, `chunk too long: ${ch.text.length}`);
    }
  });

  test("respects \\n\\n boundaries (no mid-paragraph split)", () => {
    /* Three paragraphs, each ~60 chars. maxChars=100 forces split. */
    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    const para3 = "C".repeat(60);
    const md = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = chunkMarkdown(md, 100, 0);
    assert.ok(chunks.length >= 2, "split into multiple chunks");
    /* Each chunk must contain whole paragraphs — no partial 'A's mixed with 'B's. */
    for (const ch of chunks) {
      const seenA = ch.text.includes("A".repeat(60));
      const seenB = ch.text.includes("B".repeat(60));
      const seenC = ch.text.includes("C".repeat(60));
      const partialA = !seenA && ch.text.includes("A".repeat(10));
      const partialB = !seenB && ch.text.includes("B".repeat(10));
      const partialC = !seenC && ch.text.includes("C".repeat(10));
      assert.ok(!partialA, "no partial paragraph A");
      assert.ok(!partialB, "no partial paragraph B");
      assert.ok(!partialC, "no partial paragraph C");
    }
  });

  test("lineOffset tracks across chunks", () => {
    const para1 = "line 1\nline 2";
    const para2 = "line 3\nline 4";
    const para3 = "line 5";
    const md = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = chunkMarkdown(md, 20, 0);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0].lineOffset, 0, "first chunk starts at line 0");
    /* Subsequent chunks must have positive lineOffset. */
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].lineOffset > 0, `chunk ${i} has lineOffset > 0`);
    }
  });

  test("overlap brings tail of previous chunk into next", () => {
    /* Five paragraphs with non-trivial size. With overlap > 0 the second chunk
       should begin with content from the first chunk's tail. */
    const paras = ["alpha", "beta", "gamma", "delta", "epsilon"].map((p) => p.repeat(30));
    const md = paras.join("\n\n");
    const chunks = chunkMarkdown(md, 100, 50);
    assert.ok(chunks.length >= 2, "split required");
    /* The very last paragraph of chunk[i] should appear at the START of
       chunk[i+1] when overlap > 0 (or share a boundary paragraph). */
    if (chunks.length >= 2) {
      const tail = chunks[0].text.slice(-50);
      const head = chunks[1].text.slice(0, 100);
      /* At least some character overlap should be present. */
      assert.ok(
        head.includes(tail.slice(0, 10)) || chunks[0].text.includes(chunks[1].text.split("\n\n")[0]),
        "overlap or shared paragraph between adjacent chunks"
      );
    }
  });
});

/* ─── Group 4: mergeAnnotations (chunks → document-level) ──────────────── */

describe("mergeAnnotations: shifts line numbers by lineOffset", () => {
  test("single chunk with offset=0 → unchanged", () => {
    const merged = mergeAnnotations([
      {
        lineOffset: 0,
        ann: {
          headings: [{ line: 5, level: 2, text: "Foo" }],
          toc_block: null,
          junk_lines: [10],
        },
      },
    ]);
    assert.equal(merged.headings[0].line, 5);
    assert.deepEqual(merged.junk_lines, [10]);
  });

  test("multiple chunks: line numbers shifted", () => {
    const merged = mergeAnnotations([
      {
        lineOffset: 0,
        ann: { headings: [{ line: 3, level: 2, text: "A" }], toc_block: null, junk_lines: [] },
      },
      {
        lineOffset: 100,
        ann: { headings: [{ line: 5, level: 2, text: "B" }], toc_block: null, junk_lines: [7] },
      },
    ]);
    assert.equal(merged.headings.length, 2);
    assert.equal(merged.headings[0].line, 3);
    assert.equal(merged.headings[1].line, 105, "shifted by lineOffset");
    assert.deepEqual(merged.junk_lines, [107]);
  });

  test("deduplication: same line+text → one entry", () => {
    const merged = mergeAnnotations([
      {
        lineOffset: 0,
        ann: { headings: [{ line: 5, level: 2, text: "Same" }], toc_block: null, junk_lines: [] },
      },
      {
        /* Overlap: same line in document space (5 + 0 = 5 == 0 + 5). */
        lineOffset: 0,
        ann: { headings: [{ line: 5, level: 2, text: "Same" }], toc_block: null, junk_lines: [] },
      },
    ]);
    assert.equal(merged.headings.length, 1, "duplicate dropped");
  });
});
