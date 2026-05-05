import test from "node:test";
import assert from "node:assert/strict";

import {
  isSevereMojibakeParseResult,
  repairMojibakeLine,
  repairMojibakeText,
} from "../electron/lib/scanner/text-mojibake-repair.ts";

test("repairs CP1251 text decoded as Latin-1", () => {
  const line = "Íîâûå ñëîæíûå çàäà÷è íà Ñ++";
  const result = repairMojibakeLine(line);

  assert.equal(result.repaired, true);
  assert.equal(result.text, "Новые сложные задачи на С++");
});

test("does not corrupt already valid Cyrillic or English text", () => {
  const text = [
    "Новые сложные задачи на C++",
    "Exceptional C++ Style",
    "Стр. 4",
  ].join("\n");

  const result = repairMojibakeText(text);

  assert.equal(result.repairedLines, 0);
  assert.equal(result.text, text);
});

test("detects severe PDF glyph mojibake for OCR fallback", () => {
  const parsed = {
    metadata: { title: "\"æŒ\" ª Ł Ł. Ada-95.", warnings: [] },
    sections: [
      {
        level: 1 as const,
        title: "«æŒ» ª Ł Ł. Ada-95.",
        paragraphs: [
          "´æ æŒŁ æ º ßØ Łº Ł º ˆ.¯. ˚ æŒ ÆºŁŒŁ Ł æ æ Ł ª Łº Æ ł Ł ".repeat(3),
          "˜ßØ Łº æ Ł æ ºŁßı Ł ª ª Œ. æ æ — æ æºŁ Łæ º Ł æ º ßı ".repeat(3),
        ],
      },
    ],
    rawCharCount: 200,
  };

  assert.equal(isSevereMojibakeParseResult(parsed), true);
});
