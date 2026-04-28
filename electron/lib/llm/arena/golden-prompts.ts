/**
 * Golden prompts for shadow arena — one per role. Same question to two models,
 * comparison by latency + LLM judge -> Elo.
 *
 * Prompts are intentionally compact (context <= 500 tokens, answer <= 512) —
 * arena should not burn VRAM/time.
 */

import type { ModelRole } from "../model-role-resolver.js";

export interface GoldenPrompt {
  id: string;
  role: ModelRole;
  system: string;
  user: string;
  imageUrl?: string;
}

export const JUDGE_GOLDEN: GoldenPrompt = {
  id: "judge-v1",
  role: "judge",
  system:
    "You are a strict but fair judge. Compare two short answers and decide which is more accurate, " +
    "concise, and helpful. Output ONLY the letter A or B, no explanation.",
  user:
    "Question: What is the time complexity of inserting into a balanced BST?\n\n" +
    "Answer A: O(log n) average and worst case, because the tree stays balanced.\n\n" +
    "Answer B: O(n) because you might have to traverse the whole tree.\n\n" +
    "Which is correct? A or B?",
};

export const EXTRACTOR_GOLDEN: GoldenPrompt = {
  id: "extractor-v1",
  role: "crystallizer",
  system:
    "You extract structured knowledge from text. Output JSON: " +
    '{"facts": [string], "entities": [{"name": string, "type": string}]}.',
  user:
    "Extract knowledge from this passage:\n\n" +
    '"The Curiosity rover landed on Mars on August 6, 2012, in Gale Crater. ' +
    "It is powered by a radioisotope thermoelectric generator using plutonium-238. " +
    'NASA\'s Jet Propulsion Laboratory operates the mission."',
};

export const EVALUATOR_GOLDEN: GoldenPrompt = {
  id: "evaluator-v1",
  role: "evaluator",
  system:
    "You evaluate book quality. Score 0-10 (10 = excellent technical reference). " +
    'Output JSON: {"score": number, "reasoning": string}.',
  user:
    'Book: "Clean Code" by Robert C. Martin. Topics: software engineering best practices, ' +
    "naming conventions, function design, refactoring. Year: 2008. Pages: 464. Genre: programming reference.",
};

const TINY_WHITE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

export const VISION_GOLDEN: GoldenPrompt = {
  id: "vision-v1",
  role: "vision_meta",
  system: "You are a concise vision assistant. Describe images in one short sentence.",
  user: "Describe this image in one short sentence.",
  imageUrl: `data:image/png;base64,${TINY_WHITE_PNG_BASE64}`,
};

export const GOLDEN_PROMPTS_BY_ROLE: Partial<Record<ModelRole, GoldenPrompt>> = {
  judge: JUDGE_GOLDEN,
  crystallizer: EXTRACTOR_GOLDEN,
  evaluator: EVALUATOR_GOLDEN,
  vision_meta: VISION_GOLDEN,
  vision_ocr: VISION_GOLDEN,
};

export function getGoldenForRole(role: ModelRole): GoldenPrompt | null {
  return GOLDEN_PROMPTS_BY_ROLE[role] ?? null;
}
