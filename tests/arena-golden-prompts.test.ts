/**
 * Unit tests for electron/lib/llm/arena/golden-prompts.ts
 *
 * Тестирует: наличие golden-промпта для каждой calibratable роли,
 * корректные поля, getGoldenForRole lookup.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_GOLDEN,
  AGENT_GOLDEN,
  JUDGE_GOLDEN,
  EXTRACTOR_GOLDEN,
  EVALUATOR_GOLDEN,
  VISION_GOLDEN,
  GOLDEN_PROMPTS_BY_ROLE,
  getGoldenForRole,
  type GoldenPrompt,
} from "../electron/lib/llm/arena/golden-prompts.ts";

function assertValidPrompt(p: GoldenPrompt, expectedRole: string): void {
  assert.ok(typeof p.id === "string" && p.id.length > 0, `id empty for role ${expectedRole}`);
  assert.ok(typeof p.system === "string" && p.system.length > 5, `system too short for role ${expectedRole}`);
  assert.ok(typeof p.user === "string" && p.user.length > 5, `user too short for role ${expectedRole}`);
  assert.equal(p.role, expectedRole, `role mismatch`);
}

describe("[arena-golden-prompts] built-in prompts", () => {
  test("CHAT_GOLDEN has correct shape", () => {
    assertValidPrompt(CHAT_GOLDEN, "chat");
    assert.match(CHAT_GOLDEN.id, /chat/i);
  });

  test("AGENT_GOLDEN has correct shape and role", () => {
    assertValidPrompt(AGENT_GOLDEN, "agent");
    assert.match(AGENT_GOLDEN.id, /agent/i);
  });

  test("JUDGE_GOLDEN has correct shape and role", () => {
    assertValidPrompt(JUDGE_GOLDEN, "judge");
    assert.match(JUDGE_GOLDEN.id, /judge/i);
  });

  test("EXTRACTOR_GOLDEN has correct shape and crystallizer role", () => {
    assertValidPrompt(EXTRACTOR_GOLDEN, "crystallizer");
    assert.match(EXTRACTOR_GOLDEN.id, /extract/i);
  });

  test("EVALUATOR_GOLDEN has correct shape and role", () => {
    assertValidPrompt(EVALUATOR_GOLDEN, "evaluator");
    assert.match(EVALUATOR_GOLDEN.id, /eval/i);
  });

  test("VISION_GOLDEN has correct shape, vision_meta role, and imageUrl", () => {
    assertValidPrompt(VISION_GOLDEN, "vision_meta");
    assert.ok(typeof VISION_GOLDEN.imageUrl === "string" && VISION_GOLDEN.imageUrl.startsWith("data:image/"),
      "VISION_GOLDEN.imageUrl must be a data URL");
  });
});

describe("[arena-golden-prompts] GOLDEN_PROMPTS_BY_ROLE map", () => {
  const calibratableRoles = ["chat", "agent", "judge", "crystallizer", "evaluator", "vision_meta"] as const;

  for (const role of calibratableRoles) {
    test(`has golden prompt for role '${role}'`, () => {
      const g = GOLDEN_PROMPTS_BY_ROLE[role];
      assert.ok(g !== undefined, `no golden for ${role}`);
      assertValidPrompt(g!, role);
    });
  }

  test("vision_ocr shares VISION_GOLDEN with vision_meta (same golden, same bucket)", () => {
    /* vision_ocr is excluded from CALIBRATABLE_ROLES (no own arena cycle) but
       its golden is registered in the map so getGoldenForRole can be called for it
       if needed in the future. It shares the same VISION_GOLDEN as vision_meta. */
    const g = GOLDEN_PROMPTS_BY_ROLE["vision_ocr"];
    assert.ok(g !== undefined, "vision_ocr should share VISION_GOLDEN");
    assert.equal(g!.id, VISION_GOLDEN.id, "same id as VISION_GOLDEN");
  });

  test("does NOT have golden for arena_judge (cascade to judge)", () => {
    assert.equal(GOLDEN_PROMPTS_BY_ROLE["arena_judge"], undefined);
  });
});

describe("[arena-golden-prompts] getGoldenForRole", () => {
  test("returns correct prompt for each calibratable role", () => {
    const roles = ["chat", "agent", "judge", "crystallizer", "evaluator", "vision_meta"] as const;
    for (const role of roles) {
      const g = getGoldenForRole(role);
      assert.ok(g !== null, `getGoldenForRole(${role}) returned null`);
      assert.equal(g!.role, role);
    }
  });

  test("returns null for arena_judge (not in map)", () => {
    assert.equal(getGoldenForRole("arena_judge"), null);
  });

  test("returns VISION_GOLDEN for vision_ocr (shares vision_meta bucket)", () => {
    const g = getGoldenForRole("vision_ocr");
    assert.ok(g !== null, "vision_ocr should return VISION_GOLDEN");
    assert.equal(g!.id, VISION_GOLDEN.id);
  });
});
