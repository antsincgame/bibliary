/**
 * Cross-model fallback в extractDeltaKnowledge: после двух попыток на одной
 * модели (temperature) — переход на следующую модель из цепочки.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { clearPromptCache, extractDeltaKnowledge } from "../electron/lib/dataset-v2/delta-extractor.ts";
import type { SemanticChunk } from "../electron/lib/dataset-v2/types.ts";

const MINI_DELTA_TEMPLATE = `Context {{BREADCRUMB}}
Thesis {{CHAPTER_THESIS}}
Domains {{ALLOWED_DOMAINS}}
Overlap {{OVERLAP_CONTEXT}}
Chunk:
{{CHUNK_TEXT}}
`;

function mkChunk(): SemanticChunk {
  return {
    chapterTitle: "Ch1",
    breadcrumb: "Book > Ch1",
    partN: 1,
    partTotal: 1,
    text: "Some substantive paragraph about thermodynamics and entropy in closed systems.",
    overlapText: "",
    chapterIndex: 0,
    bookTitle: "Test Book",
    bookSourcePath: "/tmp/test-book.txt",
    wordCount: 12,
  };
}

function validDeltaJson(): string {
  return JSON.stringify({
    domain: "science",
    chapterContext: "1234567890 chapter context for the chunk",
    essence: "x".repeat(35),
    cipher: "cipher5",
    proof: "1234567890 proof text long enough",
    applicability: "",
    auraFlags: ["authorship", "specialization"],
    tags: ["entropy"],
  });
}

test("extractDeltaKnowledge: cross-model fallback when first model returns zod-invalid JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bibliary-delta-xm-"));
  try {
    await writeFile(join(dir, "delta-knowledge-extractor.md"), MINI_DELTA_TEMPLATE, "utf8");

    const badLlm = async () => ({
      content: JSON.stringify({
        domain: "science",
        essence: "too short",
        /* остальное намеренно битое — zod fail */
      }),
    });

    const goodLlm = async () => ({ content: validDeltaJson() });

    const r = await extractDeltaKnowledge({
      chunks: [mkChunk()],
      chapterThesis: "Chapter introduces physical foundations.",
      promptsDir: dir,
      callbacks: {
        llm: badLlm,
        onEvent: () => {},
      },
      extractModelChain: ["model-a", "model-b"],
      getLlmForModel: (mk) => (mk === "model-a" ? badLlm : goodLlm),
    });

    assert.equal(r.accepted.length, 1, "second model should produce accepted delta");
    assert.ok(
      r.warnings.some((w) => w.includes("cross-model-fallback")),
      `expected cross-model warning in ${JSON.stringify(r.warnings)}`,
    );
    assert.equal(r.accepted[0]!.domain, "science");
  } finally {
    clearPromptCache();
  }
});
