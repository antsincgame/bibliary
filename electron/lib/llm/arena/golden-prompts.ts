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

export const TRANSLATOR_GOLDEN: GoldenPrompt = {
  id: "translator-v1",
  role: "translator",
  system:
    "You are a professional translator. Translate the user's text into Russian. " +
    "Preserve technical terms, code snippets and numbers exactly. " +
    "Output ONLY the translation, no commentary, no quotes around the result.",
  user:
    "Алгоритм пошуку в глибину (DFS) обходить дерево, починаючи з кореня, " +
    "і йде якомога глибше по кожній гілці перед поверненням назад. " +
    "Складність — O(V + E), де V — кількість вершин, E — кількість ребер.",
};

/* ─── Olympic-style extra disciplines ─────────────────────────────────────
 *
 * Один golden даёт неустойчивую оценку: модель может «угадать» лёгкий тест
 * и провалить тяжёлый. Олимпиада — несколько разных дисциплин внутри одной
 * роли, чтобы выявить настоящего чемпиона. Все промпты компактны
 * (≤500 tokens вход, ≤512 на выход).
 */

const JUDGE_GOLDEN_TIE: GoldenPrompt = {
  id: "judge-v2-tie",
  role: "judge",
  system:
    "You are a strict but fair judge. Compare two short answers and decide which is more accurate. " +
    "Output ONLY the letter A or B.",
  user:
    "Question: What does the SQL keyword JOIN do?\n\n" +
    "Answer A: It combines rows from two tables based on a related column.\n\n" +
    "Answer B: It merges tables.\n\n" +
    "Which answer is more precise? A or B?",
};

const JUDGE_GOLDEN_TRAP: GoldenPrompt = {
  id: "judge-v3-trap",
  role: "judge",
  system:
    "You are a strict but fair judge. Compare two short answers and decide which is more accurate. " +
    "Output ONLY the letter A or B.",
  user:
    "Question: What is the chemical symbol for gold?\n\n" +
    "Answer A: Gd.\n\n" +
    "Answer B: Au, derived from the Latin 'aurum'.\n\n" +
    "Which is correct? A or B?",
};

const EXTRACTOR_GOLDEN_HISTORY: GoldenPrompt = {
  id: "extractor-v2-history",
  role: "crystallizer",
  system:
    "You extract structured knowledge from text. Output JSON: " +
    '{"facts": [string], "entities": [{"name": string, "type": string}]}.',
  user:
    "Extract knowledge:\n\n" +
    '"The Berlin Wall fell on November 9, 1989. It separated East and West Berlin for 28 years. ' +
    'It was demolished by 1992."',
};

const EXTRACTOR_GOLDEN_PROGRAMMING: GoldenPrompt = {
  id: "extractor-v3-prog",
  role: "crystallizer",
  system:
    "You extract structured knowledge from text. Output JSON: " +
    '{"facts": [string], "entities": [{"name": string, "type": string}]}.',
  user:
    "Extract knowledge:\n\n" +
    '"React was created by Jordan Walke at Facebook and first released in 2013. ' +
    "It uses a virtual DOM and component-based architecture. " +
    'The current major version (as of 2024) is React 19.x with Server Components."',
};

const EVALUATOR_GOLDEN_LOWQ: GoldenPrompt = {
  id: "evaluator-v2-lowq",
  role: "evaluator",
  system:
    "You evaluate book quality. Score 0-10 (10 = excellent technical reference). " +
    'Output JSON: {"score": number, "reasoning": string}.',
  user:
    'Book: "10 Easy Tips to Be a Coder in 2 Days" — self-published, 32 pages, ' +
    "year: 2023. Topics: vague programming advice, no code examples, multiple typos. " +
    "Reviews: average 1.8/5.",
};

const EVALUATOR_GOLDEN_SCIENCE: GoldenPrompt = {
  id: "evaluator-v3-science",
  role: "evaluator",
  system:
    "You evaluate book quality. Score 0-10 (10 = excellent technical reference). " +
    'Output JSON: {"score": number, "reasoning": string}.',
  user:
    'Book: "Introduction to Algorithms" by Cormen, Leiserson, Rivest, Stein (CLRS). ' +
    "Topics: algorithm analysis, sorting, graph algorithms, dynamic programming, NP-completeness. " +
    "Year: latest 4th ed. 2022. Pages: 1312. Used by top universities worldwide.",
};

const TRANSLATOR_GOLDEN_TECH: GoldenPrompt = {
  id: "translator-v2-tech",
  role: "translator",
  system:
    "You are a professional translator. Translate the user's text into Russian. " +
    "Preserve technical terms, code snippets and numbers exactly. " +
    "Output ONLY the translation, no commentary.",
  user:
    "DFS алгоритм використовує стек глибини. Псевдокод:\n\n" +
    "```\nfunction dfs(node):\n  if node is null: return\n  visit(node)\n  for child in node.children:\n    dfs(child)\n```\n\n" +
    "Часова складність — O(V + E).",
};

const TRANSLATOR_GOLDEN_PROSE: GoldenPrompt = {
  id: "translator-v3-prose",
  role: "translator",
  system:
    "You are a professional translator. Translate the user's text into Russian. " +
    "Preserve names and proper nouns. Output ONLY the translation, no commentary.",
  user:
    "Тарас Шевченко народився 9 березня 1814 року в селі Моринці. " +
    "Його найвідоміший збірник віршів — «Кобзар», уперше виданий у 1840 році в Санкт-Петербурзі.",
};

/**
 * Олимпиада: список дисциплин на роль. Первый — «default» (используется в
 * legacy-коде через getGoldenForRole). Остальные участвуют в «олимпиадном»
 * прогоне через getGoldensForRole.
 */
export const OLYMPIC_GOLDENS_BY_ROLE: Partial<Record<ModelRole, GoldenPrompt[]>> = {
  judge: [JUDGE_GOLDEN, JUDGE_GOLDEN_TIE, JUDGE_GOLDEN_TRAP],
  crystallizer: [EXTRACTOR_GOLDEN, EXTRACTOR_GOLDEN_HISTORY, EXTRACTOR_GOLDEN_PROGRAMMING],
  evaluator: [EVALUATOR_GOLDEN, EVALUATOR_GOLDEN_LOWQ, EVALUATOR_GOLDEN_SCIENCE],
  vision_meta: [VISION_GOLDEN],
  vision_ocr: [VISION_GOLDEN],
  translator: [TRANSLATOR_GOLDEN, TRANSLATOR_GOLDEN_TECH, TRANSLATOR_GOLDEN_PROSE],
};

export const GOLDEN_PROMPTS_BY_ROLE: Partial<Record<ModelRole, GoldenPrompt>> = {
  judge: JUDGE_GOLDEN,
  crystallizer: EXTRACTOR_GOLDEN,
  evaluator: EVALUATOR_GOLDEN,
  vision_meta: VISION_GOLDEN,
  vision_ocr: VISION_GOLDEN,
  translator: TRANSLATOR_GOLDEN,
};

export function getGoldenForRole(role: ModelRole): GoldenPrompt | null {
  return GOLDEN_PROMPTS_BY_ROLE[role] ?? null;
}

/** Все «олимпийские» дисциплины для роли (для расширенной калибровки). */
export function getGoldensForRole(role: ModelRole): GoldenPrompt[] {
  return OLYMPIC_GOLDENS_BY_ROLE[role] ?? [];
}
