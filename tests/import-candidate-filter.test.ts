import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldIncludeImportCandidate, nameTokenSimilarity } from "../electron/lib/library/import-candidate-filter.ts";

test("shouldIncludeImportCandidate: accepts real top-level book files", () => {
  assert.equal(
    shouldIncludeImportCandidate({
      rootDir: "D:\\Bibliarifull",
      candidatePath: "D:\\Bibliarifull\\Some Book - 2024.pdf",
      ext: "pdf",
      sizeBytes: 2_000_000,
    }),
    true,
  );
});

test("shouldIncludeImportCandidate: rejects forum dumps, asset trees and html shards", () => {
  assert.equal(
    shouldIncludeImportCandidate({
      rootDir: "D:\\Bibliarifull",
      candidatePath: "D:\\Bibliarifull\\forum_1426\\lesson.pdf",
      ext: "pdf",
      sizeBytes: 400_000,
    }),
    false,
  );
  assert.equal(
    shouldIncludeImportCandidate({
      rootDir: "D:\\Bibliarifull",
      candidatePath: "D:\\Bibliarifull\\Book\\assets\\appendix.pdf",
      ext: "pdf",
      sizeBytes: 400_000,
    }),
    false,
  );
  assert.equal(
    shouldIncludeImportCandidate({
      rootDir: "D:\\Bibliarifull",
      candidatePath: "D:\\Bibliarifull\\Book\\html\\chapter01.html",
      ext: "html",
      sizeBytes: 200_000,
    }),
    false,
  );
});

test("shouldIncludeImportCandidate: rejects tiny txt and course solutions", () => {
  assert.equal(
    shouldIncludeImportCandidate({
      rootDir: "D:\\Bibliarifull",
      candidatePath: "D:\\Bibliarifull\\Course\\solution.txt",
      ext: "txt",
      sizeBytes: 100_000,
    }),
    false,
  );
  assert.equal(
    shouldIncludeImportCandidate({
      rootDir: "D:\\Bibliarifull",
      candidatePath: "D:\\Bibliarifull\\notes.txt",
      ext: "txt",
      sizeBytes: 8_000,
    }),
    false,
  );
});

test("nameTokenSimilarity: detects same-book naming between parent folder and file", () => {
  assert.ok(nameTokenSimilarity("Practical Serverless and Microservices with C#", "Practical Serverless and Microservices with C# (Expert Insight)") > 0.6);
  assert.ok(nameTokenSimilarity("chapter01", "Book Folder") < 0.2);
});
