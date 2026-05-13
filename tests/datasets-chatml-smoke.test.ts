/**
 * Phase 8c — ChatML rendering smoke. Pure-функция renderChatMlLine
 * над ShareGPT conversations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderChatMlLine } from "../server/lib/datasets/chatml.ts";
import type { ShareGptLine } from "../server/lib/datasets/sharegpt.ts";

function makeShareGptLine(overrides: Partial<ShareGptLine> = {}): ShareGptLine {
  return {
    conversations: [
      { from: "system", value: "You are an expert in engineering." },
      { from: "human", value: "Why does linear FEM converge quadratically?" },
      {
        from: "gpt",
        value:
          "Linear basis functions interpolate exactly up to second derivatives; on uniform meshes the constants align so the H1-norm error scales as h².",
      },
    ],
    metadata: {
      conceptId: "c1",
      bookId: "b1",
      collectionName: "training-v1",
      createdAt: "2026-05-12T13:00:00Z",
      domain: "engineering",
      auraFlags: ["specialization", "causality"],
    },
    ...overrides,
  };
}

describe("ChatML renderer", () => {
  it("wraps each turn в <|im_start|>...<|im_end|>", () => {
    const out = renderChatMlLine(makeShareGptLine());
    assert.ok(out.text.startsWith("<|im_start|>system\n"));
    assert.ok(out.text.includes("<|im_end|>"));
    assert.ok(out.text.includes("<|im_start|>user\n"));
    assert.ok(out.text.includes("<|im_start|>assistant\n"));
  });

  it("role mapping: human→user, gpt→assistant", () => {
    const out = renderChatMlLine(makeShareGptLine());
    /* Make sure NO 'human' / 'gpt' label leaked into rendered text */
    assert.ok(!out.text.includes("<|im_start|>human"));
    assert.ok(!out.text.includes("<|im_start|>gpt"));
  });

  it("3 turn blocks → 3 <|im_start|> markers", () => {
    const out = renderChatMlLine(makeShareGptLine());
    const startCount = (out.text.match(/<\|im_start\|>/g) ?? []).length;
    const endCount = (out.text.match(/<\|im_end\|>/g) ?? []).length;
    assert.equal(startCount, 3);
    assert.equal(endCount, 3);
  });

  it("metadata preserved from source ShareGPT line", () => {
    const out = renderChatMlLine(makeShareGptLine());
    assert.equal(out.metadata.conceptId, "c1");
    assert.equal(out.metadata.bookId, "b1");
    assert.equal(out.metadata.domain, "engineering");
    assert.deepEqual(out.metadata.auraFlags, ["specialization", "causality"]);
  });

  it("content with newlines preserved (not escaped at render — JSONL escape на serialization)", () => {
    const line = makeShareGptLine({
      conversations: [
        { from: "system", value: "sys" },
        { from: "human", value: "line1\nline2" },
        { from: "gpt", value: "answer" },
      ],
    });
    const out = renderChatMlLine(line);
    /* Raw text может содержать \n — это OK на этом уровне; JSON.stringify
     * на финальной serialization escape'нёт их корректно. */
    assert.ok(out.text.includes("line1\nline2"));
  });

  it("JSON.stringify wrap surives newlines via escape", () => {
    const line = makeShareGptLine({
      conversations: [
        { from: "system", value: "sys" },
        { from: "human", value: "multi\nline\nquestion" },
        { from: "gpt", value: "answer" },
      ],
    });
    const out = renderChatMlLine(line);
    const serialized = JSON.stringify(out);
    /* serialized — single-line string (no raw newlines, only \\n escapes). */
    assert.equal(serialized.split("\n").length, 1);
    const parsed = JSON.parse(serialized);
    assert.ok(parsed.text.includes("multi\nline\nquestion"));
  });
});
