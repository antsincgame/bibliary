/**
 * Golden prompts для shadow-арены — по одному на роль. Цель: один и тот же
 * вопрос двум моделям, сравнение по latency + LLM judge → Elo.
 *
 * Промпты намеренно компактные (контекст ≤500 токенов, ответ ≤512) —
 * arena не должна жечь VRAM/время.
 */

import type { ModelRole } from "../model-role-resolver.js";

export interface GoldenPrompt {
  id: string;
  /** Какой роли соответствует prompt. Резолвит в `roles[role]` Elo bucket. */
  role: ModelRole;
  system: string;
  user: string;
  /**
   * Опциональный image_url (data: или https://) для vision-ролей.
   * Если задан, prompt отправляется как multimodal message.
   */
  imageUrl?: string;
}

export const CHAT_GOLDEN: GoldenPrompt = {
  id: "chat-v1",
  role: "chat",
  system: "You are a concise expert assistant. Answer in plain language. No preambles.",
  user: "In one or two sentences, what is the difference between precision and recall in information retrieval?",
};

export const AGENT_GOLDEN: GoldenPrompt = {
  id: "agent-v1",
  role: "agent",
  system:
    "You are an autonomous coding assistant. You must reason step-by-step before acting. " +
    "Available tools: search_web(query), read_file(path), write_file(path, content). " +
    "Reply ONLY with a JSON object: {\"thought\": string, \"tool\": string, \"args\": object}.",
  user:
    "Task: Find the current version of Node.js LTS and write it into /tmp/node-version.txt. " +
    "What is your first action?",
};

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
    "{\"facts\": [string], \"entities\": [{\"name\": string, \"type\": string}]}.",
  user:
    "Extract knowledge from this passage:\n\n" +
    "\"The Curiosity rover landed on Mars on August 6, 2012, in Gale Crater. " +
    "It is powered by a radioisotope thermoelectric generator using plutonium-238. " +
    "NASA's Jet Propulsion Laboratory operates the mission.\"",
};

export const EVALUATOR_GOLDEN: GoldenPrompt = {
  id: "evaluator-v1",
  role: "evaluator",
  system:
    "You evaluate book quality. Score 0-10 (10 = excellent technical reference). " +
    "Output JSON: {\"score\": number, \"reasoning\": string}.",
  user:
    "Book: \"Clean Code\" by Robert C. Martin. Topics: software engineering best practices, " +
    "naming conventions, function design, refactoring. Year: 2008. Pages: 464. Genre: programming reference.",
};

/**
 * Vision golden — миниатюрная 1×1 PNG в base64 (data URL). Это не настоящая
 * проверка vision-качества, а sanity-test что vision-pipeline у модели работает
 * и она не падает на пустом изображении. Реальные vision-модели должны вернуть
 * "I see a single white pixel" или аналогичный краткий ответ.
 *
 * Для production-grade vision калибровки нужны golden обложки книг —
 * это вне scope v3.4 (см. plans/MODELS-PHASE7.md).
 */
const TINY_WHITE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

export const VISION_GOLDEN: GoldenPrompt = {
  id: "vision-v1",
  role: "vision_meta",
  system: "You are a concise vision assistant. Describe images in one short sentence.",
  user: "Describe this image in one short sentence.",
  imageUrl: `data:image/png;base64,${TINY_WHITE_PNG_BASE64}`,
};

/**
 * Все golden prompts по ролям. Используется arena/run-cycle.ts для
 * выбора нужного prompt по роли.
 */
export const GOLDEN_PROMPTS_BY_ROLE: Partial<Record<ModelRole, GoldenPrompt>> = {
  chat: CHAT_GOLDEN,
  agent: AGENT_GOLDEN,
  judge: JUDGE_GOLDEN,
  crystallizer: EXTRACTOR_GOLDEN,
  evaluator: EVALUATOR_GOLDEN,
  vision_meta: VISION_GOLDEN,
  vision_ocr: VISION_GOLDEN,
  /* arena_judge не калибруется собственным cycle — он cascade'ит на judge */
};

export function getGoldenForRole(role: ModelRole): GoldenPrompt | null {
  return GOLDEN_PROMPTS_BY_ROLE[role] ?? null;
}
