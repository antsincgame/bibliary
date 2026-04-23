/**
 * Unit tests for electron/lib/library/reasoning-parser.ts
 *
 * Цель Phase 12 плана: 6 кейсов из спецификации:
 *   1. think + json (happy path)
 *   2. json only (no think tag)
 *   3. think + malformed json
 *   4. no closing think tag
 *   5. escaped quotes inside think
 *   6. partial JSON missing required field (parser-level: just verifies
 *      the JSON is returned and validation is delegated to caller / Zod)
 *
 * Plus extras for safety:
 *   7. empty input
 *   8. unbalanced braces in JSON
 *   9. nested object with quoted braces inside strings
 *
 * Запуск: `npm test` (под капотом node --test --import tsx tests/*.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReasoningResponse } from "../electron/lib/library/reasoning-parser.ts";

interface Eval {
  quality_score: number;
  domain: string;
}

test("[1] think + JSON happy path", () => {
  const raw = `<think>analyzing toc... it has 12 chapters</think>{"quality_score": 75, "domain": "ux"}`;
  const r = parseReasoningResponse<Eval>(raw);
  assert.equal(r.reasoning, "analyzing toc... it has 12 chapters");
  assert.deepEqual(r.json, { quality_score: 75, domain: "ux" });
  assert.deepEqual(r.warnings, []);
});

test("[2] JSON only, no <think>", () => {
  const raw = `{"quality_score": 42, "domain": "marketing"}`;
  const r = parseReasoningResponse<Eval>(raw);
  assert.equal(r.reasoning, null);
  assert.deepEqual(r.json, { quality_score: 42, domain: "marketing" });
  assert.deepEqual(r.warnings, []);
});

test("[3] think + malformed JSON returns reasoning + null json + warning", () => {
  const raw = `<think>I think this is good</think>{"quality_score": 80, "domain":}`;
  const r = parseReasoningResponse<Eval>(raw);
  assert.equal(r.reasoning, "I think this is good");
  assert.equal(r.json, null);
  assert.ok(r.warnings.some((w) => w.includes("JSON.parse")), `expected JSON.parse warning, got: ${JSON.stringify(r.warnings)}`);
});

test("[4] unclosed <think> tag — preserved as reasoning, payload empty, warning emitted", () => {
  const raw = `<think>this response was truncated mid-thought because`;
  const r = parseReasoningResponse<Eval>(raw);
  assert.equal(r.reasoning, "this response was truncated mid-thought because");
  assert.equal(r.json, null);
  assert.ok(r.warnings.some((w) => w.includes("unclosed <think>")));
});

test("[5] escaped quotes inside think AND in JSON string values", () => {
  const raw = `<think>the title is "Don't Make Me Think"</think>{"title": "Don\\"t Make Me Think", "quality_score": 90}`;
  const r = parseReasoningResponse<{ title: string; quality_score: number }>(raw);
  assert.ok(r.reasoning?.includes(`"Don't Make Me Think"`));
  assert.equal(r.json?.title, `Don"t Make Me Think`);
  assert.equal(r.json?.quality_score, 90);
});

test("[6] partial JSON (missing required field) — parser returns the object as-is", () => {
  /* Parser does NOT enforce a schema; that's the caller's job (Zod).
     We just verify the JSON is correctly extracted even when a field is absent. */
  const raw = `<think>...</think>{"quality_score": 50}`;
  const r = parseReasoningResponse<Eval>(raw);
  assert.deepEqual(r.json, { quality_score: 50 });
  /* `domain` is undefined — caller's Zod schema will reject. */
  assert.equal((r.json as Partial<Eval> | null)?.domain, undefined);
});

test("[7] empty input returns warning, no throw", () => {
  const r = parseReasoningResponse("");
  assert.equal(r.reasoning, null);
  assert.equal(r.json, null);
  assert.ok(r.warnings.some((w) => w.includes("empty input")));
});

test("[8] unbalanced braces (open without close) — graceful null", () => {
  const raw = `{"a": 1, "b": [1, 2`;
  const r = parseReasoningResponse(raw);
  assert.equal(r.json, null);
  assert.ok(r.warnings.some((w) => w.includes("no balanced JSON object")));
});

test("[9] braces inside string literal don't break depth tracking", () => {
  const raw = `{"sql": "SELECT * FROM t WHERE x = '{not_a_brace}'", "n": 7}`;
  const r = parseReasoningResponse<{ sql: string; n: number }>(raw);
  assert.equal(r.json?.sql, "SELECT * FROM t WHERE x = '{not_a_brace}'");
  assert.equal(r.json?.n, 7);
});

test("[10] preamble before JSON (e.g. model says 'Here is the result:') is tolerated", () => {
  const raw = `<think>thinking...</think>Here is the result:\n{"quality_score": 60, "domain": "ai"}`;
  const r = parseReasoningResponse<Eval>(raw);
  assert.equal(r.json?.quality_score, 60);
  assert.equal(r.json?.domain, "ai");
});

test("[11] postscript after JSON is tolerated (parser stops at closing brace)", () => {
  const raw = `{"quality_score": 30, "domain": "fiction"}\n\nHope this helps!`;
  const r = parseReasoningResponse<Eval>(raw);
  assert.deepEqual(r.json, { quality_score: 30, domain: "fiction" });
});

test("[12] non-string input doesn't crash", () => {
  /* Defensive: caller might pass undefined from a failed network call. */
  const r = parseReasoningResponse(undefined as unknown as string);
  assert.equal(r.json, null);
  assert.equal(r.reasoning, null);
  assert.ok(r.warnings.length > 0);
});
