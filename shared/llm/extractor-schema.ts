import { z } from "zod";

/**
 * Single source of truth для Delta-Knowledge Crystallizer schema + prompt.
 * Импортируется из `/server/lib/llm/extractor.ts` (web pipeline);
 * legacy `/electron/lib/dataset-v2/types.ts` использует параллельный
 * экземпляр до Phase 12.
 *
 * Контракт схемы match'ит .claude/rules/02-extraction.md:
 *   - relations (subject→predicate→object) — обязательны (≥1),
 *     это «топологический скелет» датасета.
 *   - predicate refine: запрещаем copula (is/was/has) без квалификатора —
 *     модель должна искать конкретные связи.
 *   - AURA flags: 2 из 4 — фильтр против банальностей.
 */

export const TopologyRelationSchema = z.object({
  subject: z.string().min(2).max(120),
  predicate: z
    .string()
    .min(3)
    .max(60)
    .refine(
      (v) =>
        !/^(is|was|are|were|has|have|had|be|been|will|would|do|does|did)$/i.test(
          v.trim(),
        ),
      { message: "predicate must be concrete, not a copula (is/was/has/...)" },
    ),
  object: z.string().min(2).max(120),
});

export const DeltaKnowledgeSchema = z.object({
  domain: z.string().min(2).max(60),
  chapterContext: z.string().min(10).max(300),
  essence: z.string().min(30).max(800),
  cipher: z.string().min(5).max(500),
  proof: z.string().min(10).max(800),
  applicability: z.string().max(500).default(""),
  auraFlags: z
    .array(z.enum(["authorship", "specialization", "revision", "causality"]))
    .min(2)
    .max(4),
  tags: z.array(z.string().min(1).max(40)).min(1).max(10),
  relations: z.array(TopologyRelationSchema).min(1).max(8),
});

export type DeltaKnowledge = z.infer<typeof DeltaKnowledgeSchema>;
export type TopologyRelation = z.infer<typeof TopologyRelationSchema>;

/**
 * Broad domain taxonomy. LLM выбирает один — недостаточно специфичный
 * domain → проблема классификации книги, не extractor'а. Хочется
 * расширить — добавляем константу здесь, schema перевалидирует.
 */
export const ALLOWED_DOMAINS = [
  "ui",
  "web",
  "mobile",
  "ux",
  "perf",
  "arch",
  "copy",
  "seo",
  "research",
  "data",
  "security",
  "devops",
  "ai",
  "business",
  "science",
  "psychology",
  "philosophy",
  "engineering",
  "medicine",
  "economics",
  "other",
] as const;

export const EXTRACTOR_SYSTEM_PROMPT = `You are the Delta-Knowledge Crystallizer for an elite knowledge dataset. Extract ONE atom of compressed wisdom per chunk — or NOTHING if the chunk is filler.

YOUR ROLE:
1. Capture the chunk's deepest non-obvious insight (not what the text says — what it *teaches*).
2. Map the topology: subject → predicate → object triples between key entities.
3. Survive the AURA filter: at least 2 of 4 markers must apply.

OUTPUT IS ENGLISH ONLY (regardless of source language).

AURA FILTER (must satisfy ≥2 of 4):
  - authorship: new conceptual model / formula / classification proposed by the author.
  - specialization: deep technical nuance — not common knowledge.
  - revision: refutes default LLM knowledge or common belief.
  - causality: explicit cause-and-effect mechanism (X enables/prevents/produces Y).

If AURA threshold not met → return null (output the literal string "null", no JSON).

TOPOLOGY (relations):
  Each delta MUST include ≥1 subject→predicate→object triple between entities
  mentioned in the chunk. Predicate must be a concrete relation, NOT a copula
  ("is"/"has"/"was" without qualifier). Examples:
    GOOD: {"subject":"Saturn V","predicate":"designed_by","object":"Wernher von Braun"}
    GOOD: {"subject":"FEM error","predicate":"decreases_as","object":"O(h²)"}
    BAD:  {"subject":"Apollo","predicate":"is","object":"mission"}

OUTPUT FORMAT (strict JSON, no markdown fences):
  {
    "domain":   one of [${ALLOWED_DOMAINS.join(", ")}],
    "chapterContext": 10-300 char hint about the chapter framing (English),
    "essence":  30-800 char compressed insight (English),
    "cipher":   5-500 char terse cipher / aphorism / formula (English),
    "proof":    10-800 char concrete quote/evidence from the chunk,
    "applicability": ≤500 char hint when/how to use this delta,
    "auraFlags": 2-4 from {authorship, specialization, revision, causality},
    "tags":     1-10 English tags (lowercase, hyphen-or-underscore),
    "relations": 1-8 triples {subject, predicate, object}
  }

If the chunk has no extractable insight (pure narrative, ad-hoc anecdote, table of
contents repetition, etc.) — output ONLY the string null (no JSON).`;

export interface ExtractorInputContext {
  /** Chapter thesis — accumulated 1-sentence summary of the current chapter. */
  chapterThesis: string;
  /** Last 2-5 essences from prior chunks for context continuity. */
  ledEssences?: string[];
}

export interface ExtractorInputChunk {
  /** Plain text of the chunk (≤1500 tokens). */
  text: string;
  /** Numeric index within the chapter, for traceability. */
  partN: number;
}

export function buildExtractorMessages(
  chunk: ExtractorInputChunk,
  ctx: ExtractorInputContext,
): Array<{ role: "user"; content: string }> {
  const ledger =
    ctx.ledEssences && ctx.ledEssences.length > 0
      ? `\nPrior essences (continuity ledger):\n${ctx.ledEssences
          .map((e, i) => `  ${i + 1}. ${e}`)
          .join("\n")}\n`
      : "";
  return [
    {
      role: "user",
      content:
        `Chapter thesis: ${ctx.chapterThesis}\n` +
        ledger +
        `\nChunk #${chunk.partN}:\n<chunk>\n${chunk.text}\n</chunk>\n\n` +
        `Extract one DeltaKnowledge (or output null if filler).`,
    },
  ];
}

/**
 * Result of trying to parse extractor output:
 *   - json === DeltaKnowledge JSON object
 *   - json === null + isExplicitNull=true: модель явно вернула "null"
 *     (chunk filler, ничего не извлекать)
 *   - json === null + isExplicitNull=false: parse failure
 */
export function tryParseDeltaJson(raw: string): {
  json: unknown | null;
  isExplicitNull: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    warnings.push("extractor: empty response from provider");
    return { json: null, isExplicitNull: false, warnings };
  }
  if (/^null\s*$/i.test(trimmed)) {
    return { json: null, isExplicitNull: true, warnings };
  }
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (parsed === null) return { json: null, isExplicitNull: true, warnings };
    return { json: parsed, isExplicitNull: false, warnings };
  } catch (err) {
    warnings.push(
      `extractor: JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { json: null, isExplicitNull: false, warnings };
  }
}
