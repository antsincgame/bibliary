/**
 * Tests for translator splitter — длинные тексты должны резаться на безопасные
 * чанки, чтобы не переполнять контекст LLM. Это ключевая защита от
 * «деградации памяти» на длинных украинских/смешанных книгах.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { splitForTranslation } from "../electron/lib/llm/translator.ts";

describe("[translator] splitForTranslation", () => {
  test("empty input returns empty array", () => {
    assert.deepEqual(splitForTranslation(""), []);
    assert.deepEqual(splitForTranslation("   \n\n  "), []);
  });

  test("short text fits into one chunk", () => {
    const text = "Hello world. This is a short paragraph.";
    const out = splitForTranslation(text, 400);
    assert.equal(out.length, 1);
    assert.equal(out[0], text);
  });

  test("multiple paragraphs combine until chunkWords boundary", () => {
    const para = "слово ".repeat(100).trim();
    const text = [para, para, para].join("\n\n");
    const out = splitForTranslation(text, 250);
    assert.ok(out.length >= 2, `expected ≥2 chunks, got ${out.length}`);
    for (const c of out) {
      const wc = c.split(/\s+/).filter(Boolean).length;
      assert.ok(wc <= 300, `chunk word-count ${wc} exceeded soft cap`);
    }
  });

  test("a single huge paragraph is split into chunkWords-size pieces", () => {
    const huge = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(" ");
    const out = splitForTranslation(huge, 400);
    assert.ok(out.length >= 4, `expected ≥4 chunks, got ${out.length}`);
    for (let i = 0; i < out.length - 1; i++) {
      const wc = out[i]!.split(/\s+/).filter(Boolean).length;
      assert.equal(wc, 400, `non-tail chunk #${i} should be exactly chunkWords`);
    }
  });

  test("preserves all source words across chunks", () => {
    const sentences = Array.from({ length: 80 }, (_, i) => `sentence-${i}.`);
    const text = sentences.join("\n\n");
    const chunks = splitForTranslation(text, 50);
    const recombined = chunks.join(" ");
    for (const s of sentences) {
      assert.ok(recombined.includes(s), `lost sentence ${s}`);
    }
  });
});
