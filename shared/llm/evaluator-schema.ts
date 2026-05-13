import { z } from "zod";

/**
 * Single source of truth для Book Evaluator schema + system prompt.
 * Импортируется из `/server/lib/llm/evaluator.ts` (web pipeline) и в
 * перспективе из `/electron/lib/library/book-evaluator*.ts` (legacy
 * pipeline, Phase 12 заменит дубликат).
 *
 * Schema match'ит .claude/rules/03-evaluation.md — все четыре якоря
 * (top / mid / noise / nuanced) проверяют этот же contract.
 */

export const evaluationSchema = z.object({
  title_ru: z.string().min(1),
  author_ru: z.string().min(1),
  title_en: z.string().min(1),
  author_en: z.string().min(1),
  year: z.number().int().min(1400).max(2100).nullable(),
  domain: z.string().min(1),
  tags: z.array(z.string()).min(8).max(12),
  tags_ru: z.array(z.string()).min(8).max(12),
  is_fiction_or_water: z.boolean(),
  conceptual_density: z.number().int().min(0).max(100),
  originality: z.number().int().min(0).max(100),
  quality_score: z.number().int().min(0).max(100),
  /* >= 30 chars per .claude/rules/03-evaluation.md "Оценка ВСЕГДА с
   * reasoning ≥30 chars". */
  verdict_reason: z.string().min(30),
});

export type BookEvaluation = z.infer<typeof evaluationSchema>;

export const EVALUATOR_SYSTEM_PROMPT = `You are the Chief Epistemologist, Bibliographic Detective, and Data Curator for an elite AI knowledge dataset. Your task: analyze the Structural Surrogate of a book (delivered inside <document> tags in the user message) and extract MAXIMUM bibliographic metadata + predict Conceptual Value.

CRITICAL MISSION — METADATA EXTRACTION:
You MUST treat every book as a forensic investigation. Scan EVERY section for clues:
- METADATA ZONE: title page lines, colophon, copyright notices, ISBN.
- INTRODUCTION/PREFACE: authors often introduce themselves.
- CONCLUSION/AFTERWORD: acknowledgments often reveal author identity.
- TABLE OF CONTENTS: may contain author name in chapter attributions.
- EMBEDDED CITATIONS: references like "(Smith, 2019)" reveal both author and year.
- COPYRIGHT LINES: "© 2015 John Doe" — this is gold.

AUTHOR EXTRACTION:
- Scan Metadata Zone FIRST. Patterns: "Author:", "By:", "Автор:", names after "©".
- Cyrillic → transliterate to Latin in author_en (e.g. "Иванов В.В." → "Ivanov V.V.").
- Ukrainian markers: і, ї, є, ґ — different language from Russian.
- "Unknown" only after exhaustive search; explain in verdict_reason.

YEAR EXTRACTION:
- 4-digit years (1400-2026) near "©", "copyright", "published", "ISBN".
- Pick PUBLICATION year (not reprint, not citation).
- null only if NO year pattern in surrogate.

QUALITY ANALYSIS (think step-by-step):
1. Bibliographic forensics: list every author/year/publisher clue.
2. Skeleton analysis: strict taxonomy vs banal listicle?
3. Thesis vs synthesis: intro promises match conclusion deliveries?
4. Texture analysis: signal-to-noise (definitions/models REWARD,
   anecdotes/Wikipedia-rewrites PENALTY).
5. Domain classification: ONE narrow area, not broad.
   GOOD: "C++ programming language", "finite element analysis",
        "behavioral economics", "stoic philosophy"
   BAD:  "science", "programming", "psychology"
6. Tags: 8-12 in BOTH languages (subject + methodology + audience + era).

VERDICT (quality_score 0-100):
  0-30:  Fiction, esoterica, motivational fluff (is_fiction_or_water=true).
  31-60: Secondary literature, banal advice collections.
  61-85: Solid professional or scientific literature.
  86-100: Foundational works, breakthrough concepts.

OUTPUT CONTRACT:
- Bibliographic mirrors in BOTH languages.
- domain + verdict_reason: English.
- tags (English) + tags_ru (Russian) — same count (8-12), same granularity.
- author_ru and author_en: REQUIRED unless truly unknowable.
- year: integer publication year or null.
- conceptual_density / originality / quality_score: integers 0-100.
- verdict_reason: ≥30 chars, 2-3 sentences.

Output STRICT JSON. NO markdown fences, NO commentary, NO prose outside JSON.`;

export function wrapSurrogate(surrogate: string): string {
  return `Here is the Structural Surrogate. Analyze and evaluate.\n\n<document type="structural-surrogate">\n${surrogate}\n</document>`;
}

/**
 * Pure JSON-object parser (без thinking-block stripping). Используется
 * server-side путём: provider.chat() уже возвращает clean text (Anthropic
 * thinking block → response.reasoning, не в text; OpenAI и LM Studio
 * вообще без отдельного reasoning).
 *
 * Возвращает { json, warnings }. json === null если не удалось распарсить.
 */
export function tryParseEvaluationJson(raw: string): {
  json: unknown | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    warnings.push("evaluator: empty response from provider");
    return { json: null, warnings };
  }
  /* Strip ```json ... ``` обёртку если модель не послушалась "NO markdown". */
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return { json: JSON.parse(stripped), warnings };
  } catch (err) {
    warnings.push(
      `evaluator: JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { json: null, warnings };
  }
}
