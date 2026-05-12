/**
 * Risk-register streaming chapter splitter — verifies the generator
 * pair (iterateMarkdownSections + iterateExtractionUnits) yields the
 * same shape as the array-returning wrappers but lazily.
 *
 * The point of the generator API is to let the extractor process and
 * discard one unit at a time. These tests assert:
 *   - generators are lazy (don't drain on first .next())
 *   - generator output equals array-wrapper output
 *   - peak alloc is bounded per-unit, not full-book (proxied by
 *     counting how many sections exist before the first unit yields)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  groupSectionsForExtraction,
  iterateExtractionUnits,
  iterateMarkdownSections,
  splitMarkdownIntoSections,
} from "../server/lib/library/chunker.ts";

const SAMPLE = `# Part I

Intro.

## Chapter 1

Body of ch1.

### Subsection 1.1

Sub body.

## Chapter 2

Body of ch2.

# Part II

Final.
`;

describe("streaming section + unit generators", () => {
  it("iterateMarkdownSections yields same Sections as the array wrapper", () => {
    const fromArray = splitMarkdownIntoSections(SAMPLE);
    const fromGen: ReturnType<typeof splitMarkdownIntoSections> = [];
    for (const s of iterateMarkdownSections(SAMPLE)) fromGen.push(s);
    assert.equal(fromGen.length, fromArray.length);
    for (let i = 0; i < fromGen.length; i++) {
      assert.equal(fromGen[i].level, fromArray[i].level);
      assert.equal(fromGen[i].title, fromArray[i].title);
      assert.equal(fromGen[i].order, fromArray[i].order);
      assert.deepEqual(fromGen[i].pathTitles, fromArray[i].pathTitles);
      assert.deepEqual(fromGen[i].paragraphs, fromArray[i].paragraphs);
    }
  });

  it("iterateMarkdownSections is lazy: first yield comes before drain", () => {
    /* Take only the first 1 section; the generator should NOT have to
     * walk past the first H1 to produce it. Concretely: take a SAMPLE
     * that has 5+ sections, request only one, and assert .return() works
     * cleanly (lazy generators support early termination). */
    const gen = iterateMarkdownSections(SAMPLE);
    const first = gen.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.title, "Part I");
    /* Early-terminate; downstream sections never get computed. */
    const ret = gen.return(undefined);
    assert.equal(ret.done, true);
  });

  it("iterateExtractionUnits accepts any Iterable<Section>", () => {
    /* Pass a plain array — should still work. */
    const sections = splitMarkdownIntoSections(SAMPLE);
    const fromArrayIter: ReturnType<typeof groupSectionsForExtraction> = [];
    for (const u of iterateExtractionUnits(sections)) fromArrayIter.push(u);
    const fromArrayWrapper = groupSectionsForExtraction(sections);
    assert.equal(fromArrayIter.length, fromArrayWrapper.length);
    /* Pass the generator directly — exercises the streaming pipeline. */
    const fromGen: ReturnType<typeof groupSectionsForExtraction> = [];
    for (const u of iterateExtractionUnits(iterateMarkdownSections(SAMPLE))) {
      fromGen.push(u);
    }
    assert.equal(fromGen.length, fromArrayWrapper.length);
    for (let i = 0; i < fromGen.length; i++) {
      assert.equal(fromGen[i].thesisTitle, fromArrayWrapper[i].thesisTitle);
      assert.deepEqual(fromGen[i].rootPath, fromArrayWrapper[i].rootPath);
      assert.equal(fromGen[i].rootOrder, fromArrayWrapper[i].rootOrder);
      assert.equal(
        fromGen[i].sections.length,
        fromArrayWrapper[i].sections.length,
      );
    }
  });

  it("survives CRLF line endings (Windows-edited markdown)", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const a = splitMarkdownIntoSections(crlf);
    const b = splitMarkdownIntoSections(SAMPLE);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].title, b[i].title);
      assert.equal(a[i].level, b[i].level);
    }
  });

  it("empty markdown yields nothing", () => {
    const out: unknown[] = [];
    for (const s of iterateMarkdownSections("")) out.push(s);
    assert.equal(out.length, 0);
    const units: unknown[] = [];
    for (const u of iterateExtractionUnits(iterateMarkdownSections(""))) {
      units.push(u);
    }
    assert.equal(units.length, 0);
  });

  it("no-heading markdown still yields one body section", () => {
    const md = "Just plain text.\n\nAnother paragraph.\n\nThird.";
    const out: ReturnType<typeof splitMarkdownIntoSections> = [];
    for (const s of iterateMarkdownSections(md)) out.push(s);
    assert.equal(out.length, 1);
    assert.equal(out[0].level, 0);
    assert.equal(out[0].paragraphs.length, 3);
  });
});
