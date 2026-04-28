import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSignature,
  scoreFile,
  findDuplicates,
  type LibrarianFile,
} from "../electron/lib/library/librarian.ts";

test("normalizeSignature: editions and formats collapse to same signature", () => {
  const a = normalizeSignature("/x/CLRS Introduction to Algorithms 4th ed. 2022.pdf");
  const b = normalizeSignature("/x/CLRS Introduction to Algorithms 3rd ed 2009.epub");
  const c = normalizeSignature("/x/CLRS_Introduction_to_Algorithms_(2nd_ed,_2001).djvu");
  assert.equal(a, b);
  assert.equal(a, c);
});

test("normalizeSignature: different books → different signatures", () => {
  const a = normalizeSignature("/x/CLRS Introduction to Algorithms.pdf");
  const b = normalizeSignature("/x/Skiena Algorithm Design Manual.pdf");
  assert.notEqual(a, b);
});

test("scoreFile: PDF + recent year > DJVU + old year", () => {
  const pdf2022 = scoreFile({ absPath: "/x/CLRS 4th ed. 2022.pdf", sizeBytes: 50_000_000 });
  const djvu1999 = scoreFile({ absPath: "/x/CLRS 1st ed. 1999.djvu", sizeBytes: 5_000_000 });
  assert.ok(pdf2022.score > djvu1999.score, `pdf2022(${pdf2022.score}) should beat djvu1999(${djvu1999.score})`);
});

test("scoreFile: 'scan' in name applies penalty", () => {
  const clean = scoreFile({ absPath: "/x/Book 2020.pdf", sizeBytes: 10_000_000 });
  const scan  = scoreFile({ absPath: "/x/Book 2020 scan.pdf", sizeBytes: 10_000_000 });
  assert.ok(clean.score > scan.score);
});

test("findDuplicates: clusters duplicates and picks newest+best format", async () => {
  const files: LibrarianFile[] = [
    { absPath: "/x/CLRS Introduction to Algorithms 4th ed 2022.pdf", sizeBytes: 50_000_000 },
    { absPath: "/x/CLRS Introduction to Algorithms 3rd ed 2009.djvu", sizeBytes: 8_000_000 },
    { absPath: "/x/CLRS Introduction to Algorithms 2nd ed 2001 scan.pdf", sizeBytes: 80_000_000 },
    { absPath: "/x/Skiena Algorithm Design Manual.pdf", sizeBytes: 30_000_000 },
  ];
  const clusters = await findDuplicates(files, {
    enableLlmTieBreak: false, /* deterministic only */
  });
  assert.equal(clusters.length, 1, "exactly one cluster (Skiena is alone)");
  const cl = clusters[0]!;
  assert.match(cl.winner.absPath, /4th ed 2022\.pdf$/, `winner should be 4th ed PDF, got ${cl.winner.absPath}`);
  assert.equal(cl.runnersUp.length, 2);
  assert.equal(cl.llmUsed, false);
});

test("findDuplicates: invokes LLM tie-break when margin < threshold", async () => {
  /* Same signature, identical scoring → margin = 0 → LLM tie-break fires. */
  const files: LibrarianFile[] = [
    { absPath: "/x/copy1/Pragmatic Programmer 2nd ed 2019.pdf", sizeBytes: 10_000_000 },
    { absPath: "/x/copy2/Pragmatic Programmer 2nd ed 2019.pdf", sizeBytes: 10_000_000 },
  ];
  let llmCalled = false;
  const clusters = await findDuplicates(files, {
    enableLlmTieBreak: true,
    llmTieBreakThreshold: 100,
    llmTieBreak: async (cands, sig) => {
      llmCalled = true;
      assert.equal(cands.length, 2);
      assert.ok(sig.length > 0);
      return { winnerIndex: 1, reason: "test pick second" };
    },
  });
  assert.equal(clusters.length, 1);
  assert.equal(llmCalled, true);
  assert.equal(clusters[0]!.llmUsed, true);
    assert.match(clusters[0]!.winner.absPath, /copy2\//);
  assert.match(clusters[0]!.reason, /LLM/);
});

test("findDuplicates: no duplicates → empty clusters array", async () => {
  const clusters = await findDuplicates(
    [
      { absPath: "/x/A.pdf", sizeBytes: 1_000 },
      { absPath: "/x/B.pdf", sizeBytes: 2_000 },
      { absPath: "/x/C.pdf", sizeBytes: 3_000 },
    ],
    { enableLlmTieBreak: false },
  );
  assert.equal(clusters.length, 0);
});

test("findDuplicates: progress events fire", async () => {
  const files: LibrarianFile[] = [
    { absPath: "/x/Book 2022.pdf", sizeBytes: 1 },
    { absPath: "/x/Book 2020.pdf", sizeBytes: 1 },
  ];
  const events: string[] = [];
  await findDuplicates(files, {
    enableLlmTieBreak: false,
    onProgress: (e) => events.push(e.type),
  });
  assert.ok(events.includes("librarian.start"));
  assert.ok(events.includes("librarian.cluster"));
  assert.ok(events.includes("librarian.done"));
});
