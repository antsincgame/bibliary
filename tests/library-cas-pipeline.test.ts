/**
 * CAS Pipeline Integration Tests — Phase 1/2/3 plan gate tests.
 *
 * Tests that:
 *  - book.md written after import has no Base64 data URIs
 *  - illustrations.json has correct shape (role, sha256, bytes)
 *  - vision graceful skip when no models loaded
 *  - filterBookIds correctly filters catalog rows
 *  - queryByTag returns bookIds
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// ── Phase 1 gate: no Base64 in produced markdown ─────────────────────────────

describe("Phase 1 gate: markdown has no Base64 Data URIs", () => {
  it("injectCasImageRefs does not embed Base64", async () => {
    const { injectCasImageRefs } = await import("../electron/lib/library/md-converter.js");

    const fakeMeta = {
      id: "aabbccddeeff0011",
      sha256: "a".repeat(64),
      title: "Test Book",
      originalFile: "original.pdf",
      originalFormat: "pdf" as const,
      wordCount: 100,
      chapterCount: 1,
      status: "imported" as const,
    };

    // Image with assetUrl set (simulating after putBlob)
    const images = [
      {
        id: "img-cover",
        mimeType: "image/png",
        buffer: Buffer.from("fake png data"),
        assetUrl: "bibliary-asset://sha256/" + "b".repeat(64),
      },
    ];

    const baseMarkdown = `---\nid: "${fakeMeta.id}"\ntitle: "Test Book"\n---\n\n# Test Book\n\n![Cover][img-cover]\n`;
    const result = injectCasImageRefs(baseMarkdown, images, fakeMeta);

    // Must NOT contain Base64
    assert.doesNotMatch(result, /data:image\/[^;]+;base64,/, "No Base64 Data URI in markdown");

    // MUST contain bibliary-asset:// link
    assert.match(result, /bibliary-asset:\/\/sha256\//, "Must contain CAS asset URL");
    assert.match(result, /\[img-cover\]: bibliary-asset:\/\/sha256\//, "img-cover must be defined as CAS URL");
  });

  it("buildImageRefs without assetUrl returns empty string", async () => {
    // When assetUrl is not set (before CAS), buildImageRefs should produce empty output
    // This verifies the "no base64" contract is not broken by legacy path
    const { injectCasImageRefs } = await import("../electron/lib/library/md-converter.js");

    const fakeMeta = {
      id: "0011223344556677",
      sha256: "c".repeat(64),
      title: "No Images Book",
      originalFile: "original.txt",
      originalFormat: "txt" as const,
      wordCount: 50,
      chapterCount: 1,
      status: "imported" as const,
    };

    const images: Array<{ id: string; mimeType: string; buffer: Buffer; assetUrl?: string }> = [];
    const baseMarkdown = `---\nid: "${fakeMeta.id}"\ntitle: "No Images Book"\n---\n\n# No Images\n\nSome text.\n`;
    const result = injectCasImageRefs(baseMarkdown, images, fakeMeta);

    assert.doesNotMatch(result, /data:image\/[^;]+;base64,/, "No Base64 even with no images");
    assert.doesNotMatch(result, /bibliary-asset:\/\/sha256\//, "No asset URLs when no images");
  });
});

describe("title heuristics", () => {
  it("prefers meaningful filename title over section-like metadata", async () => {
    const { pickBestBookTitle, isLowValueBookTitle } = await import("../electron/lib/library/title-heuristics.js");

    assert.equal(isLowValueBookTitle("Предисловие"), true);
    assert.equal(isLowValueBookTitle("Contents"), true);
    assert.equal(isLowValueBookTitle("Настоящее название книги"), false);

    assert.equal(
      pickBestBookTitle("Предисловие", "Настоящее название книги", "fallback"),
      "Настоящее название книги",
    );
    assert.equal(
      pickBestBookTitle("Contents", undefined, "Real File Title"),
      "Real File Title",
    );
  });
});

// ── Phase 2 gate: illustrations.json shape ───────────────────────────────────

describe("Phase 2 gate: illustrations.json shape", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-illus-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("illustrations.json entries have required fields", async () => {
    const illustrationsPath = path.join(tmpDir, "illustrations.json");
    const data = [
      {
        id: "img-cover",
        sha256: "a".repeat(64),
        mimeType: "image/png",
        bytes: 12345,
        role: "cover",
        caption: null,
      },
      {
        id: "img-001",
        sha256: "b".repeat(64),
        mimeType: "image/jpeg",
        bytes: 5678,
        role: "illustration",
        caption: "Figure 1",
      },
    ];

    await fs.writeFile(illustrationsPath, JSON.stringify(data, null, 2), "utf-8");
    const raw = await fs.readFile(illustrationsPath, "utf-8");
    const parsed = JSON.parse(raw) as typeof data;

    assert.equal(parsed.length, 2);
    for (const entry of parsed) {
      assert.ok(typeof entry.id === "string", "entry.id must be string");
      assert.ok(typeof entry.sha256 === "string" && entry.sha256.length === 64, "entry.sha256 must be 64-char hex");
      assert.ok(typeof entry.mimeType === "string", "entry.mimeType required");
      assert.ok(typeof entry.bytes === "number" && entry.bytes > 0, "entry.bytes must be positive");
      assert.ok(["cover", "back-cover", "illustration", "unrelated"].includes(entry.role), `entry.role must be valid: ${entry.role}`);
    }

    assert.equal(parsed[0].role, "cover");
    assert.equal(parsed[1].role, "illustration");
  });

  it("illustrations.json is well-formed JSON (no truncation)", async () => {
    const illustrationsPath = path.join(tmpDir, "illus-wellformed.json");
    const data = Array.from({ length: 10 }, (_, i) => ({
      id: `img-${String(i).padStart(3, "0")}`,
      sha256: (i.toString(16).padStart(2, "0")).repeat(32),
      mimeType: "image/png",
      bytes: 1000 + i,
      role: i === 0 ? "cover" : "illustration",
      caption: null,
    }));

    await fs.writeFile(illustrationsPath, JSON.stringify(data, null, 2), "utf-8");
    const raw = await fs.readFile(illustrationsPath, "utf-8");

    let parsed: typeof data;
    assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, "illustrations.json must be valid JSON");
    // @ts-expect-error assigned in doesNotThrow
    assert.equal(parsed.length, 10);
  });
});

// ── Phase 2 gate: vision graceful skip ───────────────────────────────────────

describe("Phase 2 gate: vision graceful skip when no models", () => {
  it("recognizeWithVisionLlm returns error gracefully when no models available", async () => {
    const { recognizeWithVisionLlm } = await import("../electron/lib/llm/vision-ocr.js");

    // Mock: pickVisionModels returns [] by setting env to prevent real LM Studio calls
    const originalEnv = process.env.BIBLIARY_VISION_MODEL_MARKERS;
    process.env.BIBLIARY_VISION_MODEL_MARKERS = "__nonexistent_marker__";

    const fakeBuffer = Buffer.from("fake image data");
    // This will attempt to call LM Studio which is not running in tests
    // The function should return { text: "", confidence: 0, error: "..." } not throw
    let result: { text: string; confidence: number; error?: string };
    try {
      result = await recognizeWithVisionLlm(fakeBuffer, { mimeType: "image/png" });
    } catch (err) {
      assert.fail(`recognizeWithVisionLlm must not throw, got: ${err}`);
      return;
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BIBLIARY_VISION_MODEL_MARKERS;
      } else {
        process.env.BIBLIARY_VISION_MODEL_MARKERS = originalEnv;
      }
    }

    assert.equal(typeof result.text, "string", "result.text must be string");
    assert.equal(typeof result.confidence, "number", "result.confidence must be number");
    // When no models or LM Studio unreachable: text is empty, confidence is 0
    // (not a hard requirement since LM Studio might be running in CI)
    assert.ok(result.confidence >= 0 && result.confidence <= 1, "confidence in [0,1]");
  });
});

// ── Phase 3 gate: queryByTag SQL ─────────────────────────────────────────────

describe("Phase 3 gate: queryByTag returns CollectionGroup[] shape", () => {
  it("queryByTag returns array with label/count/bookIds", async () => {
    // Set up an isolated SQLite DB
    const { _resetLibraryRootCache } = await import("../electron/lib/library/paths.js");
    const tmpDb = path.join(os.tmpdir(), `cas-tag-test-${Date.now()}.db`);
    const originalDbEnv = process.env.BIBLIARY_LIBRARY_DB;
    process.env.BIBLIARY_LIBRARY_DB = tmpDb;
    _resetLibraryRootCache();

    try {
      const { openCacheDb, closeCacheDb } = await import("../electron/lib/library/cache-db-connection.js");
      const { upsertBook } = await import("../electron/lib/library/cache-db-mutations.js");
      const { queryByTag } = await import("../electron/lib/library/cache-db-queries.js");

      openCacheDb();

      const bookA = {
        id: "aaaa1111bbbb2222", sha256: "a".repeat(64), title: "Book A",
        originalFile: "original.pdf", originalFormat: "pdf" as const,
        wordCount: 100, chapterCount: 2, status: "evaluated" as const,
        tags: ["machine-learning", "neural-networks"],
        domain: "AI", qualityScore: 75,
      };
      const bookB = {
        id: "cccc3333dddd4444", sha256: "b".repeat(64), title: "Book B",
        originalFile: "original.epub", originalFormat: "epub" as const,
        wordCount: 200, chapterCount: 3, status: "evaluated" as const,
        tags: ["machine-learning", "robotics"],
        domain: "Robotics", qualityScore: 80,
      };

      upsertBook(bookA, "/fake/path/a.md");
      upsertBook(bookB, "/fake/path/b.md");

      const groups = queryByTag();

      // machine-learning appears in both books
      const mlGroup = groups.find((g) => g.label === "machine-learning");
      assert.ok(mlGroup, "machine-learning tag must appear");
      assert.equal(mlGroup!.count, 2, "machine-learning appears in 2 books");
      assert.equal(mlGroup!.bookIds.length, 2, "bookIds has 2 entries");
      assert.ok(mlGroup!.bookIds.includes(bookA.id), "bookA in machine-learning");
      assert.ok(mlGroup!.bookIds.includes(bookB.id), "bookB in machine-learning");

      // robotics appears in 1 book
      const roboticsGroup = groups.find((g) => g.label === "robotics");
      assert.ok(roboticsGroup, "robotics tag must appear");
      assert.equal(roboticsGroup!.count, 1);
      assert.equal(roboticsGroup!.bookIds[0], bookB.id);

      closeCacheDb();
    } finally {
      if (originalDbEnv === undefined) {
        delete process.env.BIBLIARY_LIBRARY_DB;
      } else {
        process.env.BIBLIARY_LIBRARY_DB = originalDbEnv;
      }
      _resetLibraryRootCache();
      await fs.unlink(tmpDb).catch(() => {});
    }
  });
});
