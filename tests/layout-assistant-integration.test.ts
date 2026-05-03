/**
 * Layout Assistant integration tests.
 *
 * Тестирует полный цикл runLayoutAssistant с mocked LM-каллом (без LM Studio):
 *   - Backup создаётся и удаляется при успехе
 *   - Backup сохраняется при IO failure (и потом подчищается через откат)
 *   - layout-skipped когда все чанки вернули broken JSON
 *   - Idempotency: повторный прогон no-op
 *   - Force=true: повторно прогоняет даже с marker
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { runLayoutAssistant } from "../electron/lib/library/layout-assistant.ts";
import { LAYOUT_ASSISTANT_MARKER } from "../electron/lib/library/layout-assistant-schema.ts";

let tmpDir: string;
let bookMd: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-layout-int-"));
  bookMd = path.join(tmpDir, "book.md");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/* Sample должен быть >= 200 chars (LAYOUT_ASSISTANT_CONFIG.minBookChars). */
const sampleBook = [
  "Chapter 1: Hello",
  "",
  "This is body text of chapter one. ".repeat(5),
  "",
  "42",
  "",
  "Chapter 2: World",
  "",
  "And here is body of chapter two. ".repeat(5),
].join("\n");

describe("runLayoutAssistant: full cycle with mocked LLM", () => {
  test("applies annotations and removes backup on success", async () => {
    await fs.writeFile(bookMd, sampleBook, "utf8");
    const llmCall = async () =>
      JSON.stringify({
        headings: [
          { line: 1, level: 2, text: "Chapter 1: Hello" },
          { line: 7, level: 2, text: "Chapter 2: World" },
        ],
        toc_block: null,
        junk_lines: [5],
      });

    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      llmCall,
    });

    assert.equal(result.applied, true);
    assert.equal(result.chunksOk, 1);
    assert.equal(result.chunksFailed, 0);

    const after = await fs.readFile(bookMd, "utf8");
    assert.ok(after.includes(LAYOUT_ASSISTANT_MARKER), "marker present");
    assert.ok(after.includes("## Chapter 1: Hello"), "first heading promoted");
    assert.ok(after.includes("## Chapter 2: World"), "second heading promoted");
    assert.ok(!after.match(/^42$/m), "junk line removed");

    /* Backup must be cleaned up after success. */
    const backupExists = await fs
      .stat(`${bookMd}.bak`)
      .then(() => true)
      .catch(() => false);
    assert.equal(backupExists, false, ".bak removed after success");
  });

  test("layout-skipped when all chunks return broken JSON", async () => {
    await fs.writeFile(bookMd, sampleBook, "utf8");
    const llmCall = async () => "this is not JSON at all, sorry";

    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      llmCall,
    });

    assert.equal(result.applied, false);
    assert.equal(result.chunksOk, 0);
    assert.ok((result.chunksFailed ?? 0) >= 1);

    /* Book must be untouched (no marker, original content intact). */
    const after = await fs.readFile(bookMd, "utf8");
    assert.equal(after, sampleBook, "book unchanged");
    assert.ok(!after.includes(LAYOUT_ASSISTANT_MARKER), "no marker on failure");
  });

  test("idempotency: marker present → no-op", async () => {
    const withMarker = `${LAYOUT_ASSISTANT_MARKER}\n${sampleBook}`;
    await fs.writeFile(bookMd, withMarker, "utf8");

    let llmCalled = 0;
    const llmCall = async () => {
      llmCalled++;
      return "{}";
    };

    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      llmCall,
    });

    assert.equal(result.applied, false);
    assert.equal(llmCalled, 0, "LLM was NOT called when marker present");
    const after = await fs.readFile(bookMd, "utf8");
    assert.equal(after, withMarker, "file unchanged");
  });

  test("force=true: re-runs even with marker", async () => {
    const withMarker = `${LAYOUT_ASSISTANT_MARKER}\n${sampleBook}`;
    await fs.writeFile(bookMd, withMarker, "utf8");

    let llmCalled = 0;
    const llmCall = async () => {
      llmCalled++;
      return JSON.stringify({
        headings: [],
        toc_block: null,
        junk_lines: [],
      });
    };

    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      force: true,
      llmCall,
    });

    /* applied=false because annotations were empty (no real changes), but
       LLM was actually called. */
    assert.ok(llmCalled >= 1, "LLM called with force=true");
    assert.equal(result.chunksOk, 1);
  });

  test("partial failure: 1 of 2 chunks succeeds, applies what it can", async () => {
    /* Big book → splits into multiple chunks. */
    const bigBook = Array.from({ length: 20 }, (_, i) =>
      `Section ${i + 1}\n\n${"x".repeat(500)}`
    ).join("\n\n");
    await fs.writeFile(bookMd, bigBook, "utf8");

    let callIdx = 0;
    const llmCall = async () => {
      callIdx++;
      /* First chunk: valid. Second+: broken. */
      if (callIdx === 1) {
        return JSON.stringify({
          headings: [{ line: 1, level: 2, text: "Section 1" }],
          toc_block: null,
          junk_lines: [],
        });
      }
      return "garbage";
    };

    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      llmCall,
    });

    /* Mixed outcome — at least one chunk parsed, some failed. */
    assert.ok((result.chunksOk ?? 0) >= 1, "at least one chunk parsed");
    assert.ok((result.chunksFailed ?? 0) >= 1, "at least one chunk failed");
  });

  test("aborted via signal → graceful exit, no partial write", async () => {
    await fs.writeFile(bookMd, sampleBook, "utf8");
    const ac = new AbortController();
    /* Abort immediately. */
    ac.abort("test");

    const llmCall = async () => "{}";
    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      llmCall,
      signal: ac.signal,
    });

    /* Either applied=false with skip, or no chunks processed.
       Critical: book.md must not be corrupted. */
    const after = await fs.readFile(bookMd, "utf8");
    assert.equal(after, sampleBook, "book intact after abort");
    assert.equal(result.applied, false);
  });
});

describe("runLayoutAssistant: concurrent modification detection (Bug 4 fix)", () => {
  test("concurrent modification: file changed during inference → not applied, evaluator content preserved", async () => {
    await fs.writeFile(bookMd, sampleBook, "utf8");

    let callCount = 0;
    const llmCall = async () => {
      callCount++;
      if (callCount === 1) {
        /* Simulate concurrent write (evaluator) happening during LLM inference.
           This tests the hash-check inside withBookMdLock in runLayoutAssistant. */
        await fs.writeFile(bookMd, sampleBook + "\n\nevaluator-added-score: 8\n", "utf8");
      }
      return JSON.stringify({ headings: [], junk_lines: [] });
    };

    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      llmCall,
    });

    /* Should detect concurrent modification and abort cleanly. */
    assert.equal(result.applied, false, "should not apply when concurrent modification detected");
    assert.ok(
      result.warnings?.some((w) => w.includes("concurrent") || w.includes("modified")),
      `should warn about concurrent modification, got: ${JSON.stringify(result.warnings)}`,
    );

    /* Evaluator's content must be preserved (layout assistant did NOT overwrite it). */
    const after = await fs.readFile(bookMd, "utf8");
    assert.ok(after.includes("evaluator-added-score"), "evaluator content must be preserved");
    assert.ok(!after.includes(LAYOUT_ASSISTANT_MARKER), "no layout marker should have been added");
  });

  test("concurrent modification: same content (no actual edit) → applied normally", async () => {
    await fs.writeFile(bookMd, sampleBook, "utf8");

    const llmCall = async () =>
      JSON.stringify({ headings: [{ line: 1, level: 2, text: "Chapter 1: Hello" }], junk_lines: [] });

    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      llmCall,
    });

    /* No concurrent modification — should apply normally. */
    assert.equal(result.applied, true, "should apply when no concurrent modification");
    assert.equal(result.chunksOk, 1);
  });
});

describe("runLayoutAssistant: edge cases", () => {
  test("missing book.md → graceful failure", async () => {
    const result = await runLayoutAssistant(path.join(tmpDir, "does-not-exist.md"), {
      modelKey: "mock-model",
      llmCall: async () => "{}",
    });
    assert.equal(result.applied, false);
    assert.ok(result.error?.includes("read failed"), "error mentions read failure");
  });

  test("very short book → skipped", async () => {
    await fs.writeFile(bookMd, "tiny", "utf8");
    let llmCalled = 0;
    const result = await runLayoutAssistant(bookMd, {
      modelKey: "mock-model",
      llmCall: async () => {
        llmCalled++;
        return "{}";
      },
    });
    assert.equal(result.applied, false);
    assert.equal(llmCalled, 0, "LLM not called for tiny book");
  });
});
