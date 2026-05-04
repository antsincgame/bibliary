import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import {
  sanitizeSegment,
  buildHumanBookPath,
  resolveWithMaxPathGuard,
  extractSphereFromImportPath,
  resolveCollisionSuffix,
  MAX_SEGMENT_LEN,
} from "../electron/lib/library/path-sanitizer.js";
import {
  resolveHumanBookPaths,
  resolveSidecarPaths,
  resolveLegacySidecarPaths,
} from "../electron/lib/library/storage-contract.js";

describe("sanitizeSegment", () => {
  it("removes forbidden characters", () => {
    assert.equal(sanitizeSegment('hello\\world/:*?"<>|'), "helloworld");
  });

  it("replaces spaces with underscores", () => {
    assert.equal(sanitizeSegment("hello world test"), "hello_world_test");
  });

  it("removes control characters", () => {
    assert.equal(sanitizeSegment("hello\x00\x01\x1Fworld"), "helloworld");
  });

  it("strips leading/trailing dots and spaces", () => {
    assert.equal(sanitizeSegment("...test..."), "test");
    assert.equal(sanitizeSegment("  test  "), "test");
  });

  it("replaces .. with .", () => {
    assert.equal(sanitizeSegment("path..traversal"), "path.traversal");
  });

  it("truncates to MAX_SEGMENT_LEN", () => {
    const long = "A".repeat(100);
    const result = sanitizeSegment(long);
    assert.ok(result.length <= MAX_SEGMENT_LEN, `Expected <= ${MAX_SEGMENT_LEN}, got ${result.length}`);
  });

  it("returns _unnamed for empty input", () => {
    assert.equal(sanitizeSegment(""), "_unnamed");
    assert.equal(sanitizeSegment(":::"), "_unnamed");
  });

  it("prefixes reserved Windows names", () => {
    assert.equal(sanitizeSegment("CON"), "_CON");
    assert.equal(sanitizeSegment("PRN"), "_PRN");
    assert.equal(sanitizeSegment("NUL"), "_NUL");
    assert.equal(sanitizeSegment("COM1"), "_COM1");
    assert.equal(sanitizeSegment("LPT9"), "_LPT9");
  });

  it("preserves Unicode (Cyrillic, Ukrainian)", () => {
    const result = sanitizeSegment("Квантовая механика");
    assert.ok(result.includes("Квантовая"), `Expected Cyrillic preserved, got ${result}`);
  });

  it("NFC normalizes Unicode", () => {
    const composed = "\u0049\u0301"; // Í in NFD
    const result = sanitizeSegment(composed);
    assert.equal(result, "\u00CD"); // NFC
  });
});

describe("buildHumanBookPath", () => {
  it("builds path with author and title", () => {
    const p = buildHumanBookPath({
      language: "en",
      domain: "Mathematics",
      author: "Donald Knuth",
      title: "The Art of Computer Programming",
      bookIdShort: "abcdef12",
    });
    assert.equal(p.language, "en");
    assert.equal(p.domain, "Mathematics");
    assert.equal(p.authorFolder, "Donald_Knuth");
    assert.ok(p.relPath.includes(path.join("en", "Mathematics", "Donald_Knuth")), `relPath: ${p.relPath}`);
    assert.ok(p.mdFileName.endsWith(".md"), `md file should end with .md: ${p.mdFileName}`);
  });

  it("builds path without author", () => {
    const p = buildHumanBookPath({
      language: "ru",
      domain: "Cybernetics",
      title: "Control Theory",
      bookIdShort: "12345678",
    });
    assert.equal(p.authorFolder, "unknown_author");
    assert.ok(!p.relPath.includes("undefined"), "no undefined in path");
    assert.ok(p.mdFileName.includes("Control_Theory"), `mdFileName: ${p.mdFileName}`);
  });

  it("defaults language/domain/author", () => {
    const p = buildHumanBookPath({
      title: "Test",
      bookIdShort: "00000000",
    });
    assert.equal(p.language, "unknown");
    assert.equal(p.domain, "unsorted");
    assert.equal(p.authorFolder, "unknown_author");
  });

  it("truncates very long author folder to MAX_SEGMENT_LEN", () => {
    const p = buildHumanBookPath({
      language: "en",
      domain: "Science",
      author: "A".repeat(60),
      title: "B".repeat(60),
      bookIdShort: "abcdef12",
    });
    assert.ok(p.authorFolder.length <= MAX_SEGMENT_LEN, `authorFolder too long: ${p.authorFolder.length}`);
    assert.ok(p.mdFileName.length <= MAX_SEGMENT_LEN + 3, `mdFileName too long: ${p.mdFileName.length}`);
  });
});

describe("resolveWithMaxPathGuard", () => {
  it("uses normal path when under MAX_PATH", () => {
    const humanPath = buildHumanBookPath({
      language: "en",
      domain: "Math",
      author: "Euler",
      title: "Calculus",
      bookIdShort: "aabbccdd",
    });
    const result = resolveWithMaxPathGuard("C:\\lib", humanPath, "aabbccdd");
    assert.ok(result.mdPath.includes("Calculus.md"), `mdPath: ${result.mdPath}`);
  });

  it("falls back to short path when MAX_PATH exceeded", () => {
    const humanPath = buildHumanBookPath({
      language: "en",
      domain: "A".repeat(50),
      author: "B".repeat(50),
      title: "C".repeat(50),
      bookIdShort: "aabbccdd",
    });
    const longRoot = "D:\\" + "x".repeat(180);
    const result = resolveWithMaxPathGuard(longRoot, humanPath, "aabbccdd");
    assert.ok(result.mdPath.length <= 260, `Path too long: ${result.mdPath.length}`);
  });
});

describe("extractSphereFromImportPath", () => {
  const importRoot = path.join(os.tmpdir(), "Bibliarifull");

  it("extracts first folder segment as sphere", () => {
    const sphere = extractSphereFromImportPath(
      path.join(importRoot, "Mathematics", "Knuth.pdf"),
      importRoot,
    );
    assert.equal(sphere, "Mathematics");
  });

  it("returns unsorted for files in root", () => {
    const sphere = extractSphereFromImportPath(
      path.join(importRoot, "book.pdf"),
      importRoot,
    );
    assert.equal(sphere, "unsorted");
  });

  it("handles deep nesting", () => {
    const sphere = extractSphereFromImportPath(
      path.join(importRoot, "Science", "Physics", "Quantum", "book.pdf"),
      importRoot,
    );
    assert.equal(sphere, "Science");
  });
});

describe("resolveCollisionSuffix", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-collision-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns original path when directory does not exist", async () => {
    const target = path.join(tmpDir, "NewBook");
    const result = await resolveCollisionSuffix(target, fs);
    assert.equal(result, target);
  });

  it("returns -2 suffix when original exists", async () => {
    const target = path.join(tmpDir, "ExistingBook");
    await fs.mkdir(target);
    const result = await resolveCollisionSuffix(target, fs);
    assert.equal(result, `${target}-2`);
  });

  it("returns -3 suffix when -2 also exists", async () => {
    const target = path.join(tmpDir, "DoubleCollision");
    await fs.mkdir(target);
    await fs.mkdir(`${target}-2`);
    const result = await resolveCollisionSuffix(target, fs);
    assert.equal(result, `${target}-3`);
  });

  it("different books with same title get unique suffixed directories", async () => {
    const target = path.join(tmpDir, "SameTitle");
    await fs.mkdir(target);

    const suffix2 = await resolveCollisionSuffix(target, fs);
    await fs.mkdir(suffix2);
    const suffix3 = await resolveCollisionSuffix(target, fs);

    assert.notEqual(suffix2, target);
    assert.notEqual(suffix3, target);
    assert.notEqual(suffix3, suffix2);
  });
});

describe("storage sidecar layout", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-storage-layout-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves new language/domain/author/Book.md layout with basename sidecars", async () => {
    const stored = await resolveHumanBookPaths(
      tmpDir,
      {
        id: "abcdef123456",
        title: "My Chess Book",
        author: "Mikhail Botvinnik",
        originalFormat: "pdf",
        language: "ru",
        domain: "chess",
      },
      "D:\\Bibliarifull\\chess\\book.pdf",
      "D:\\Bibliarifull",
    );

    assert.ok(stored.relPath.includes(path.join("ru", "chess", "Mikhail_Botvinnik")), stored.relPath);
    assert.equal(path.basename(stored.mdPath), "My_Chess_Book.md");
    assert.equal(path.basename(stored.originalPath), "My_Chess_Book.original.pdf");
    assert.equal(path.basename(stored.metaPath), "My_Chess_Book.meta.json");
    assert.equal(path.basename(stored.illustrationsPath), "My_Chess_Book.illustrations.json");
  });

  it("resolves sidecars from mdPath", () => {
    const mdPath = path.join(tmpDir, "ru", "chess", "Author", "Book.md");
    const sidecars = resolveSidecarPaths(mdPath, "epub");
    assert.equal(sidecars.originalFile, "Book.original.epub");
    assert.equal(sidecars.originalPath, path.join(tmpDir, "ru", "chess", "Author", "Book.original.epub"));
    assert.equal(sidecars.metaPath, path.join(tmpDir, "ru", "chess", "Author", "Book.meta.json"));
    assert.equal(sidecars.illustrationsPath, path.join(tmpDir, "ru", "chess", "Author", "Book.illustrations.json"));
  });

  it("keeps legacy sidecars for old layout", () => {
    const mdPath = path.join(tmpDir, "legacy-id", "book.md");
    const sidecars = resolveLegacySidecarPaths(mdPath, "original.pdf", "pdf");
    assert.equal(sidecars.originalPath, path.join(tmpDir, "legacy-id", "original.pdf"));
    assert.equal(sidecars.metaPath, path.join(tmpDir, "legacy-id", "meta.json"));
    assert.equal(sidecars.illustrationsPath, path.join(tmpDir, "legacy-id", "illustrations.json"));
  });
});
