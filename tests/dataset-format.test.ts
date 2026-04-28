/**
 * Unit tests for electron/lib/dataset-v2/format.ts
 *
 * Covers: ShareGPT↔ChatML conversion, JSONL serialization,
 * train/val/eval split with seeded shuffle (reproducibility).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  shareGptToChatML,
  chatMLToShareGPT,
  chatMLLinesToJsonl,
  shareGptLinesToJsonl,
  splitLines,
  type ShareGPTLine,
  type ChatMLLine,
} from "../electron/lib/dataset-v2/format.ts";

describe("[dataset-format] ShareGPT → ChatML", () => {
  test("converts roles correctly", () => {
    const sg: ShareGPTLine = {
      conversations: [
        { from: "system", value: "You are helpful." },
        { from: "human", value: "Hello" },
        { from: "gpt", value: "Hi!" },
      ],
    };
    const cm = shareGptToChatML(sg);
    assert.equal(cm.messages.length, 3);
    assert.equal(cm.messages[0]!.role, "system");
    assert.equal(cm.messages[1]!.role, "user");
    assert.equal(cm.messages[2]!.role, "assistant");
    assert.equal(cm.messages[0]!.content, "You are helpful.");
    assert.equal(cm.messages[2]!.content, "Hi!");
  });

  test("preserves meta when present", () => {
    const sg: ShareGPTLine = {
      conversations: [{ from: "human", value: "q" }, { from: "gpt", value: "a" }],
      meta: { source: "test" },
    };
    const cm = shareGptToChatML(sg);
    assert.deepEqual(cm.meta, { source: "test" });
  });

  test("omits meta when absent", () => {
    const sg: ShareGPTLine = {
      conversations: [{ from: "human", value: "q" }, { from: "gpt", value: "a" }],
    };
    const cm = shareGptToChatML(sg);
    assert.equal("meta" in cm, false);
  });

  test("maps unknown roles to user", () => {
    const sg: ShareGPTLine = {
      conversations: [{ from: "alien", value: "beep" }],
    };
    const cm = shareGptToChatML(sg);
    assert.equal(cm.messages[0]!.role, "user");
  });
});

describe("[dataset-format] ChatML → ShareGPT", () => {
  test("converts roles correctly", () => {
    const cm: ChatMLLine = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    };
    const sg = chatMLToShareGPT(cm);
    assert.equal(sg.conversations.length, 3);
    assert.equal(sg.conversations[0]!.from, "system");
    assert.equal(sg.conversations[1]!.from, "human");
    assert.equal(sg.conversations[2]!.from, "gpt");
  });

  test("roundtrips preserve content", () => {
    const original: ShareGPTLine = {
      conversations: [
        { from: "system", value: "Expert." },
        { from: "human", value: "What is 2+2?" },
        { from: "gpt", value: "4" },
      ],
      meta: { id: "abc" },
    };
    const roundtripped = chatMLToShareGPT(shareGptToChatML(original));
    assert.deepEqual(roundtripped, original);
  });
});

describe("[dataset-format] JSONL serialization", () => {
  test("chatMLLinesToJsonl produces valid JSONL", () => {
    const lines: ChatMLLine[] = [
      { messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] },
      { messages: [{ role: "user", content: "q2" }, { role: "assistant", content: "a2" }] },
    ];
    const jsonl = chatMLLinesToJsonl(lines);
    const parsed = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].messages[0].content, "q");
    assert.equal(parsed[1].messages[1].content, "a2");
  });

  test("shareGptLinesToJsonl produces valid JSONL", () => {
    const lines: ShareGPTLine[] = [
      { conversations: [{ from: "human", value: "hi" }, { from: "gpt", value: "hello" }] },
    ];
    const jsonl = shareGptLinesToJsonl(lines);
    const parsed = JSON.parse(jsonl.trim());
    assert.equal(parsed.conversations[0].from, "human");
  });

  test("empty array produces empty string", () => {
    assert.equal(chatMLLinesToJsonl([]), "");
    assert.equal(shareGptLinesToJsonl([]), "");
  });
});

describe("[dataset-format] splitLines", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);

  test("default 90/10 split", () => {
    const { train, val, eval: ev } = splitLines(items);
    assert.equal(train.length + val.length + ev.length, 100);
    assert.equal(train.length, 90);
    assert.equal(val.length, 10);
    assert.equal(ev.length, 0);
  });

  test("custom trainRatio", () => {
    const { train, val } = splitLines(items, { trainRatio: 0.8 });
    assert.equal(train.length, 80);
    assert.equal(val.length, 20);
  });

  test("with eval split", () => {
    const { train, val, eval: ev } = splitLines(items, { trainRatio: 0.8, evalRatio: 0.1 });
    assert.equal(train.length + val.length + ev.length, 100);
    assert.equal(ev.length, 10);
    assert.equal(train.length, 72); // 80% of remaining 90
    assert.equal(val.length, 18);
  });

  test("deterministic with same seed", () => {
    const a = splitLines(items, { seed: 123 });
    const b = splitLines(items, { seed: 123 });
    assert.deepEqual(a.train, b.train);
    assert.deepEqual(a.val, b.val);
  });

  test("different seed produces different order", () => {
    const a = splitLines(items, { seed: 1 });
    const b = splitLines(items, { seed: 2 });
    const sameOrder = a.train.every((v, i) => v === b.train[i]);
    assert.equal(sameOrder, false, "different seeds should shuffle differently");
  });

  test("no items lost or duplicated", () => {
    const { train, val, eval: ev } = splitLines(items, { trainRatio: 0.7, evalRatio: 0.1, seed: 99 });
    const all = [...train, ...val, ...ev].sort((a, b) => a - b);
    assert.deepEqual(all, items);
  });
});
