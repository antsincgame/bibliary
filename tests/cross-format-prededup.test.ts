import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { CrossFormatPreDedup } from "../electron/lib/library/cross-format-prededup.ts";

const DIR = "D:\\Bibliarifull\\AI";

test("cross-format-prededup: same basename PDF + DJVU — keeps PDF (higher priority)", () => {
  const dedup = new CrossFormatPreDedup();
  const pdf = path.join(DIR, "Book.pdf");
  const djvu = path.join(DIR, "Book.djvu");

  assert.equal(dedup.check(pdf).include, true, "PDF should be accepted first");
  const djvuDecision = dedup.check(djvu);
  assert.equal(djvuDecision.include, false, "DJVU with same basename should be rejected");
  assert.equal(djvuDecision.supersededBy, pdf);
});

test("cross-format-prededup: same basename DJVU first, then PDF — PDF wins, evicts DJVU", () => {
  const dedup = new CrossFormatPreDedup();
  const djvu = path.join(DIR, "Book.djvu");
  const pdf = path.join(DIR, "Book.pdf");

  assert.equal(dedup.check(djvu).include, true, "DJVU accepted first");
  const pdfDecision = dedup.check(pdf);
  assert.equal(pdfDecision.include, true, "PDF should evict DJVU (higher priority)");
  // DJVU is now in the superseded list
  assert.ok(dedup.superseded.some((s) => s.skipped === djvu));
});

test("cross-format-prededup: EPUB > PDF > DJVU priority chain", () => {
  const dedup = new CrossFormatPreDedup();
  const djvu = path.join(DIR, "Book.djvu");
  const pdf = path.join(DIR, "Book.pdf");
  const epub = path.join(DIR, "Book.epub");

  dedup.check(djvu);
  dedup.check(pdf);   // evicts djvu
  const epubDecision = dedup.check(epub); // should evict pdf
  assert.equal(epubDecision.include, true, "EPUB evicts PDF");
  assert.ok(dedup.superseded.some((s) => s.skipped === pdf));
});

test("cross-format-prededup: different basenames both pass (v1 vs v2)", () => {
  const dedup = new CrossFormatPreDedup();
  const v1 = path.join(DIR, "Book v1.pdf");
  const v2 = path.join(DIR, "Book v2.pdf");
  const v3 = path.join(DIR, "Book v1.djvu"); // same basename as v1

  assert.equal(dedup.check(v1).include, true, "Book v1.pdf should pass");
  assert.equal(dedup.check(v2).include, true, "Book v2.pdf should pass — different basename");
  // Book v1.djvu and Book v1.pdf share the same basename "book v1"
  const v3Decision = dedup.check(v3);
  assert.equal(v3Decision.include, false, "Book v1.djvu rejected — same basename as Book v1.pdf (PDF wins)");
});

test("cross-format-prededup: different directories are independent", () => {
  const dedup = new CrossFormatPreDedup();
  const dir1 = path.join(DIR, "SubA");
  const dir2 = path.join(DIR, "SubB");
  const a = path.join(dir1, "Book.pdf");
  const b = path.join(dir2, "Book.pdf");

  assert.equal(dedup.check(a).include, true, "First dir accepted");
  assert.equal(dedup.check(b).include, true, "Same name in different dir — accepted separately");
});

test("cross-format-prededup: case insensitive basename matching", () => {
  const dedup = new CrossFormatPreDedup();
  const lower = path.join(DIR, "mybook.pdf");
  const upper = path.join(DIR, "MYBOOK.djvu");

  assert.equal(dedup.check(lower).include, true);
  const upperDecision = dedup.check(upper);
  assert.equal(upperDecision.include, false, "MYBOOK.djvu same as mybook.pdf (case insensitive)");
});

test("cross-format-prededup: unknown extension treated as lowest priority", () => {
  const dedup = new CrossFormatPreDedup();
  const txt = path.join(DIR, "Book.txt");
  const pdf = path.join(DIR, "Book.pdf");

  dedup.check(txt);
  assert.equal(dedup.check(pdf).include, true, "PDF evicts TXT (higher priority)");
});

test("cross-format-prededup: size reports correctly", () => {
  const dedup = new CrossFormatPreDedup();
  dedup.check(path.join(DIR, "A.pdf"));
  dedup.check(path.join(DIR, "B.epub"));
  dedup.check(path.join(DIR, "C.txt"));
  assert.equal(dedup.size, 3);
});
