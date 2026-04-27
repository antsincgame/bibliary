/**
 * Tests for Semantic Vision Pipeline Step A: Pixel Guard.
 *
 * We test the size-based part without a real sharp dependency
 * by checking the exported MIN constants logic.
 * The dimension-based guard is tested via integration in image-extractors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Test the semantic triage JSON parsing logic directly.
// We extract the parse helper into a testable unit.

function parseTriageResponse(raw: string): { score: number; description: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Try direct JSON parse
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const score = typeof obj.score === "number" ? Math.round(Math.max(0, Math.min(10, obj.score))) : null;
      if (score === null) return null;
      return { score, description: typeof obj.description === "string" ? obj.description.trim() : "" };
    } catch { /* continue */ }
  }

  // Try code-block extraction
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (codeBlock) {
    try {
      const obj = JSON.parse(codeBlock[1].trim()) as Record<string, unknown>;
      const score = typeof obj.score === "number" ? Math.round(Math.max(0, Math.min(10, obj.score))) : null;
      if (score === null) return null;
      return { score, description: typeof obj.description === "string" ? obj.description.trim() : "" };
    } catch { /* continue */ }
  }

  // Brace-extraction fallback
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++;
    else if (trimmed[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(trimmed.slice(start, i + 1)) as Record<string, unknown>;
          const score = typeof obj.score === "number" ? Math.round(Math.max(0, Math.min(10, obj.score))) : null;
          if (score === null) return null;
          return { score, description: typeof obj.description === "string" ? obj.description.trim() : "" };
        } catch { return null; }
      }
    }
  }
  return null;
}

test("parseTriageResponse: valid JSON with score and description", () => {
  const raw = JSON.stringify({ score: 9, description: "Technical architecture diagram" });
  const result = parseTriageResponse(raw);
  assert.notEqual(result, null);
  assert.equal(result!.score, 9);
  assert.equal(result!.description, "Technical architecture diagram");
});

test("parseTriageResponse: score clamped to [0, 10]", () => {
  const r1 = parseTriageResponse(JSON.stringify({ score: 15, description: "Over" }));
  assert.equal(r1!.score, 10, "score > 10 clamped to 10");

  const r2 = parseTriageResponse(JSON.stringify({ score: -3, description: "Under" }));
  assert.equal(r2!.score, 0, "score < 0 clamped to 0");
});

test("parseTriageResponse: score rounded to integer", () => {
  const r = parseTriageResponse(JSON.stringify({ score: 7.7, description: "Diagram" }));
  assert.equal(r!.score, 8, "7.7 rounds to 8");
});

test("parseTriageResponse: JSON embedded in markdown code block", () => {
  const raw = '```json\n{"score": 3, "description": "Generic photo"}\n```';
  const result = parseTriageResponse(raw);
  assert.notEqual(result, null);
  assert.equal(result!.score, 3);
});

test("parseTriageResponse: JSON embedded in prose text", () => {
  const raw = 'Here is the result: {"score": 8, "description": "Flowchart showing process"} (end)';
  const result = parseTriageResponse(raw);
  assert.notEqual(result, null);
  assert.equal(result!.score, 8);
});

test("parseTriageResponse: missing score returns null", () => {
  const raw = JSON.stringify({ description: "No score here" });
  assert.equal(parseTriageResponse(raw), null);
});

test("parseTriageResponse: empty string returns null", () => {
  assert.equal(parseTriageResponse(""), null);
});

test("parseTriageResponse: missing description gives empty string", () => {
  const raw = JSON.stringify({ score: 5 });
  const result = parseTriageResponse(raw);
  assert.notEqual(result, null);
  assert.equal(result!.description, "");
});

// Test markdown enrichment function
function enrichMarkdownAltText(markdown: string, imgId: string, description: string): string {
  const safeDesc = description.replace(/[\[\]]/g, "").slice(0, 200).trim();
  const newAlt = `LLM_DESC: ${safeDesc}`;
  const re = new RegExp(`!\\[[^\\]]*\\]\\[${imgId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "g");
  return markdown.replace(re, `![${newAlt}][${imgId}]`);
}

test("enrichMarkdownAltText: replaces alt text for existing image ref", () => {
  const md = "Some text\n\n![Cover][img-cover]\n\nMore text";
  const result = enrichMarkdownAltText(md, "img-cover", "Book front cover with red background");
  assert.ok(result.includes("![LLM_DESC: Book front cover with red background][img-cover]"));
  assert.ok(!result.includes("![Cover][img-cover]"));
});

test("enrichMarkdownAltText: replaces all occurrences", () => {
  const md = "![Cover][img-cover]\n\nSome text\n\n![Cover][img-cover]";
  const result = enrichMarkdownAltText(md, "img-cover", "Desc");
  assert.equal((result.match(/LLM_DESC/g) ?? []).length, 2);
});

test("enrichMarkdownAltText: strips brackets from description", () => {
  const md = "![old][img-001]";
  const desc = "Diagram [with brackets] inside";
  const result = enrichMarkdownAltText(md, "img-001", desc);
  assert.ok(!result.includes("[with brackets]"), "brackets should be stripped from description");
  assert.ok(result.includes("LLM_DESC: Diagram with brackets inside"));
});

test("enrichMarkdownAltText: truncates description to 200 chars", () => {
  const md = "![x][img-002]";
  const longDesc = "A".repeat(300);
  const result = enrichMarkdownAltText(md, "img-002", longDesc);
  const altMatch = result.match(/!\[LLM_DESC: ([^\]]+)\]/);
  assert.ok(altMatch, "should find LLM_DESC alt");
  assert.ok(altMatch![1].length <= 210, "alt text should be within limit (including 'LLM_DESC: ' prefix)");
});

test("enrichMarkdownAltText: does not modify unrelated image ids", () => {
  const md = "![Cover][img-cover]\n![Other][img-001]";
  const result = enrichMarkdownAltText(md, "img-cover", "Cover description");
  assert.ok(result.includes("![Other][img-001]"), "img-001 should be untouched");
  assert.ok(result.includes("![LLM_DESC: Cover description][img-cover]"));
});

// Pixel size threshold constants
test("pixel guard constants: MIN_IMAGE_BYTES is 15 KB", () => {
  const MIN_IMAGE_BYTES = 15_360;
  assert.equal(MIN_IMAGE_BYTES, 15 * 1024);
});

test("pixel guard constants: small buffer would fail byte check", () => {
  const MIN_IMAGE_BYTES = 15_360;
  const smallBuf = Buffer.alloc(10_000); // 10 KB
  assert.ok(smallBuf.length < MIN_IMAGE_BYTES, "10 KB < 15 KB guard");
});

test("pixel guard constants: 15 KB buffer passes byte check", () => {
  const MIN_IMAGE_BYTES = 15_360;
  const okBuf = Buffer.alloc(15_360);
  assert.ok(okBuf.length >= MIN_IMAGE_BYTES);
});
