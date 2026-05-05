/**
 * Tests for custom Olympics disciplines (Iter 14.3, 2026-05-05).
 *
 * Покрытие:
 *   - scoreFuzzy: identity, mismatch, partial, thinking-block stripping,
 *     punctuation/case insensitivity, cyrillic/latin
 *   - CustomDisciplineSchema: cross-field refine (vision требует imageRef,
 *     текст не должен иметь imageRef), bounds (maxTokens, lengths)
 *   - compileCustomDiscipline: text role -> Discipline без imageUrl,
 *     vision role с loadImage -> Discipline с imageUrl,
 *     vision без картинки (loadImage возвращает null) -> imageUrl undefined
 *   - getActiveDisciplines: статические + custom без коллизий, custom
 *     с тем же id что у статической — игнорируется
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreFuzzy,
  CustomDisciplineSchema,
  compileCustomDiscipline,
  generateDisciplineId,
  roleRequiresImage,
  type CustomDiscipline,
} from "../electron/lib/llm/arena/custom-disciplines.ts";
import {
  getActiveDisciplines,
  _setRegistryDepsForTests,
  _resetRegistryDeps,
} from "../electron/lib/llm/arena/disciplines-registry.ts";
import { OLYMPICS_DISCIPLINES } from "../electron/lib/llm/arena/disciplines.ts";

/* ─── scoreFuzzy ────────────────────────────────────────────────────────── */

test("scoreFuzzy: identical text gives 1.0", () => {
  assert.equal(scoreFuzzy("hello world", "hello world"), 1);
});

test("scoreFuzzy: completely different gives 0", () => {
  assert.equal(scoreFuzzy("foo bar", "qux quux"), 0);
});

test("scoreFuzzy: partial overlap gives intermediate score", () => {
  /* Tokens A: {hello, big, world}, B: {hello, world}; intersection = 2,
     dice = 2*2 / (3+2) = 0.8. */
  const s = scoreFuzzy("Hello big world", "hello world");
  assert.ok(s > 0.7 && s < 0.9, `expected 0.7..0.9, got ${s}`);
});

test("scoreFuzzy: punctuation is ignored", () => {
  assert.equal(scoreFuzzy("Hello, world!", "hello world"), 1);
});

test("scoreFuzzy: case-insensitive", () => {
  assert.equal(scoreFuzzy("HELLO WORLD", "hello world"), 1);
});

test("scoreFuzzy: cyrillic words tokenize correctly", () => {
  assert.equal(scoreFuzzy("Привет мир", "привет мир"), 1);
  /* Tokens: {привет, дорогой, мир} ∩ {привет, мир} = 2 → dice = 2*2/(3+2) = 0.8 */
  const s = scoreFuzzy("Привет, дорогой мир", "Привет мир");
  assert.ok(s > 0.7 && s < 0.9, `expected 0.7..0.9, got ${s}`);
});

test("scoreFuzzy: <think>...</think> block is stripped before scoring", () => {
  const answer = "<think>let me think about this problem first</think>\nhello world";
  const expected = "hello world";
  assert.equal(scoreFuzzy(answer, expected), 1);
});

test("scoreFuzzy: empty answer or expected gives 0", () => {
  assert.equal(scoreFuzzy("", "hello"), 0);
  assert.equal(scoreFuzzy("hello", ""), 0);
  assert.equal(scoreFuzzy("", ""), 0);
});

test("scoreFuzzy: result clamped to [0, 1]", () => {
  const s = scoreFuzzy("abc abc abc", "abc abc abc abc");
  assert.ok(s >= 0 && s <= 1);
});

/* ─── CustomDisciplineSchema ───────────────────────────────────────────── */

function baseTextPayload(): unknown {
  return {
    id: "custom-evaluator-test1-abc",
    role: "evaluator",
    name: "Test 1",
    description: "demo",
    system: "You are an evaluator. Reply only JSON {\"score\":N}.",
    user: "Evaluate the following: A short story about a cat.",
    expectedAnswer: "{\"score\":7,\"reasoning\":\"decent\"}",
    maxTokens: 512,
    thinkingFriendly: true,
  };
}

test("schema: valid text-role payload parses", () => {
  const r = CustomDisciplineSchema.safeParse(baseTextPayload());
  assert.ok(r.success, `expected success, got: ${!r.success ? r.error.message : ""}`);
});

test("schema: text role with imageRef is rejected", () => {
  const payload = { ...(baseTextPayload() as Record<string, unknown>), imageRef: "foo.png" };
  const r = CustomDisciplineSchema.safeParse(payload);
  assert.equal(r.success, false);
});

test("schema: vision role without imageRef is rejected", () => {
  const payload = {
    ...(baseTextPayload() as Record<string, unknown>),
    id: "custom-vision_ocr-test1-abc",
    role: "vision_ocr",
  };
  delete (payload as Record<string, unknown>).imageRef;
  const r = CustomDisciplineSchema.safeParse(payload);
  assert.equal(r.success, false);
});

test("schema: vision role with valid imageRef parses", () => {
  const payload = {
    ...(baseTextPayload() as Record<string, unknown>),
    id: "custom-vision_ocr-test1-abc",
    role: "vision_ocr",
    imageRef: "custom-vision_ocr-test1-abc.png",
  };
  const r = CustomDisciplineSchema.safeParse(payload);
  assert.ok(r.success, `expected success, got: ${!r.success ? r.error.message : ""}`);
});

test("schema: id must match custom-{role}-{slug} pattern", () => {
  const payload = { ...(baseTextPayload() as Record<string, unknown>), id: "evil/path/../escape" };
  const r = CustomDisciplineSchema.safeParse(payload);
  assert.equal(r.success, false);
});

test("schema: imageRef must be a safe filename (no path traversal)", () => {
  const payload = {
    ...(baseTextPayload() as Record<string, unknown>),
    id: "custom-vision_ocr-test1-abc",
    role: "vision_ocr",
    imageRef: "../../../etc/passwd.png",
  };
  const r = CustomDisciplineSchema.safeParse(payload);
  assert.equal(r.success, false);
});

test("schema: maxTokens out of range is rejected", () => {
  const tooHigh = { ...(baseTextPayload() as Record<string, unknown>), maxTokens: 99999 };
  assert.equal(CustomDisciplineSchema.safeParse(tooHigh).success, false);
  const tooLow = { ...(baseTextPayload() as Record<string, unknown>), maxTokens: 1 };
  assert.equal(CustomDisciplineSchema.safeParse(tooLow).success, false);
});

/* ─── compileCustomDiscipline ──────────────────────────────────────────── */

test("compile: text role produces Discipline without imageUrl", () => {
  const r = CustomDisciplineSchema.parse(baseTextPayload());
  const d = compileCustomDiscipline(r);
  assert.equal(d.id, r.id);
  assert.equal(d.role, "evaluator");
  assert.equal(d.imageUrl, undefined);
  assert.equal(d.maxTokens, 512);
  assert.equal(d.thinkingFriendly, true);
  /* score function ставит в ту же зону что scoreFuzzy. */
  const s = d.score(r.expectedAnswer);
  assert.equal(s, 1);
  const s2 = d.score("totally different");
  assert.equal(s2, 0);
});

test("compile: vision role with loadImage returns Discipline with imageUrl", () => {
  const payload = {
    ...(baseTextPayload() as Record<string, unknown>),
    id: "custom-vision_ocr-test1-abc",
    role: "vision_ocr",
    imageRef: "custom-vision_ocr-test1-abc.png",
  };
  const r = CustomDisciplineSchema.parse(payload);
  const d = compileCustomDiscipline(r, () => "data:image/png;base64,XYZ");
  assert.equal(d.imageUrl, "data:image/png;base64,XYZ");
});

test("compile: vision role without working image (loader returns null) gets undefined imageUrl", () => {
  const payload = {
    ...(baseTextPayload() as Record<string, unknown>),
    id: "custom-vision_ocr-test1-abc",
    role: "vision_ocr",
    imageRef: "missing.png",
  };
  const r = CustomDisciplineSchema.parse(payload);
  const d = compileCustomDiscipline(r, () => null);
  assert.equal(d.imageUrl, undefined);
});

/* ─── helpers ──────────────────────────────────────────────────────────── */

test("generateDisciplineId: produces stable shape", () => {
  const id = generateDisciplineId("crystallizer", "Hello World!");
  assert.match(id, /^custom-crystallizer-hello-world-[a-z0-9]+$/);
});

test("generateDisciplineId: handles cyrillic / unicode names", () => {
  const id = generateDisciplineId("vision_ocr", "Тест на распознавание");
  /* Кириллица strip-ится через NFKD + filter [a-z0-9] -> остается пустота;
     fallback "test" применяется. */
  assert.match(id, /^custom-vision_ocr-(test|[a-z0-9-]+)-[a-z0-9]+$/);
});

test("roleRequiresImage", () => {
  assert.equal(roleRequiresImage("vision_ocr"), true);
  assert.equal(roleRequiresImage("vision_illustration"), true);
  assert.equal(roleRequiresImage("crystallizer"), false);
  assert.equal(roleRequiresImage("evaluator"), false);
});

/* ─── getActiveDisciplines (registry) ──────────────────────────────────── */

test("registry: returns only static when no custom disciplines", async () => {
  _setRegistryDepsForTests({
    readCustom: async () => [],
    loadImage: () => null,
  });
  try {
    const all = await getActiveDisciplines();
    assert.equal(all.length, OLYMPICS_DISCIPLINES.length);
  } finally {
    _resetRegistryDeps();
  }
});

test("registry: appends custom disciplines after static ones", async () => {
  const custom: CustomDiscipline = CustomDisciplineSchema.parse(baseTextPayload());
  _setRegistryDepsForTests({
    readCustom: async () => [custom],
    loadImage: () => null,
  });
  try {
    const all = await getActiveDisciplines();
    assert.equal(all.length, OLYMPICS_DISCIPLINES.length + 1);
    assert.equal(all[all.length - 1]!.id, custom.id);
  } finally {
    _resetRegistryDeps();
  }
});

test("registry: defense-in-depth — custom with same id as static is dropped", async () => {
  /* Schema уже не пускает id без `custom-` префикса (статические id —
     `crystallizer-rover` и т.п.), поэтому реалистично коллизий не должно
     быть. Но registry имеет defense-in-depth: даже если кто-то обойдёт
     schema (тест эмулирует это через `as any`), статика выигрывает. */
  const staticOne = OLYMPICS_DISCIPLINES[0]!;
  const shadow = {
    ...(baseTextPayload() as Record<string, unknown>),
    id: staticOne.id,
    role: staticOne.role,
  } as unknown as CustomDiscipline;
  _setRegistryDepsForTests({
    readCustom: async () => [shadow],
    loadImage: () => null,
  });
  try {
    const all = await getActiveDisciplines();
    assert.equal(all.length, OLYMPICS_DISCIPLINES.length);
    assert.equal(all.find((d) => d.id === staticOne.id), staticOne);
  } finally {
    _resetRegistryDeps();
  }
});
