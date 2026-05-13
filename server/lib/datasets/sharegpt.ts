import { z } from "zod";

import { withProvider } from "../llm/model-resolver.js";
import type { LLMProvider } from "../llm/provider.js";
import type { DeltaKnowledge } from "../../../shared/llm/extractor-schema.js";
import { iterateAcceptedConcepts, type IterateOptions, type JsonlLine } from "./synthesize.js";

/**
 * Phase 8e — ShareGPT synthesizer (multi-difficulty + diversity + dedup).
 *
 * Базируется на исследованиях 2026 (Magpie, Evol-Instruct улучшения):
 *   1. **Three tiers per concept (T1/T2/T3)**: surface recall, applied
 *      reasoning, synthesis. Один LLM-вызов даёт три line — экономия
 *      vs три отдельных вызова, плюс инкрементальная diversity.
 *   2. **Persona-style framing** в system prompt — varied question
 *      types по rotation для diversity coverage.
 *   3. **Standardized length balance** в schema (research: balanced
 *      длина instructions = меньше noise для модели).
 *   4. **Jaccard dedup** в buffer — drops lines with question similarity
 *      > 0.92 (typical 5-15% reduction on 100-concept dataset).
 *
 * Single LLM call per concept:
 *   - Анthropic Claude Sonnet ~3-8s + prompt caching
 *   - LM Studio Qwen 14B ~30-90s
 *   - 100 concepts → ~5-15 min total (vs 30-45 min при 3 calls/concept)
 */

const QAPairSchema = z.object({
  question: z.string().min(30).max(400),
  answer: z.string().min(80).max(1500),
});

const TieredQASchema = z.object({
  t1_surface: QAPairSchema,
  t2_applied: QAPairSchema,
  t3_synthesis: QAPairSchema,
});

type QAPair = z.infer<typeof QAPairSchema>;
type TieredQA = z.infer<typeof TieredQASchema>;
export type DifficultyTier = "t1" | "t2" | "t3";

const SYSTEM_PROMPT = `You synthesize fine-tuning dataset examples from a delta-knowledge atom (essence + cipher + proof + relations). Generate THREE Q&A pairs at three difficulty tiers:

TIER 1 (surface recall):
  Question framing: "What is...", "Define...", "Name the...", "Which..."
  Tests factual recall of the cipher / definition.
  Question: 1 sentence (30-100 chars).
  Answer: 1-2 sentences (80-300 chars), direct from essence.

TIER 2 (applied reasoning):
  Question framing: "Why does X cause Y?", "How would you apply X to Y?",
    "In a scenario where..., what...", "Compare X and Y".
  Tests understanding of relations + proof.
  Question: 1-2 sentences (60-200 chars).
  Answer: 2-3 sentences (200-600 chars), uses essence + cipher + proof.

TIER 3 (synthesis):
  Question framing: "Critique...", "When does X fail?", "What's the
    boundary condition for...", "Design an experiment that tests...",
    "How does X interact with Y in domain Z?"
  Tests deep synthesis — requires combining concept with general
  knowledge.
  Question: 1-3 sentences (80-300 chars).
  Answer: 3-5 sentences (400-1200 chars), goes beyond proof into
    implications, limits, edge cases.

Rules (apply to all three tiers):
  - English only. NO markdown fences, NO "the delta says", NO meta-references.
  - Answer as if you're an expert on the topic directly.
  - Use the cipher / numeric formula verbatim if applicable.
  - Reference relations subject/object naturally в answer text.
  - NO hallucination — derive only from given essence/cipher/proof/relations.

Output STRICT JSON:
{
  "t1_surface": {"question": "...", "answer": "..."},
  "t2_applied":  {"question": "...", "answer": "..."},
  "t3_synthesis": {"question": "...", "answer": "..."}
}`;

const USER_PROMPT_TEMPLATE = (delta: DeltaKnowledge): string =>
  `Domain: ${delta.domain}

Chapter context: ${delta.chapterContext}

Essence: ${delta.essence}

Cipher: ${delta.cipher}

Proof: ${delta.proof}

${delta.applicability ? `Applicability: ${delta.applicability}\n\n` : ""}Relations:
${delta.relations.map((r) => `  - ${r.subject} ${r.predicate} ${r.object}`).join("\n")}

Generate the three tiered Q&A pairs.`;

export interface ShareGptLine {
  conversations: Array<{ from: "system" | "human" | "gpt"; value: string }>;
  metadata: {
    conceptId: string;
    bookId: string;
    collectionName: string;
    createdAt: string;
    domain: string;
    auraFlags: string[];
    tier: DifficultyTier;
  };
}

const QA_MAX_TOKENS = 2048;
const QA_TEMPERATURE = 0.6;

async function generateTieredQA(
  provider: LLMProvider,
  model: string,
  delta: DeltaKnowledge,
  signal?: AbortSignal,
): Promise<TieredQA | null> {
  const response = await provider.chat({
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_PROMPT_TEMPLATE(delta) }],
    maxTokens: QA_MAX_TOKENS,
    temperature: QA_TEMPERATURE,
    responseFormat: "json_object",
    promptCache: true,
    ...(signal ? { signal } : {}),
  });

  const raw = response.text?.trim() ?? "";
  if (!raw) return null;
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  const validation = TieredQASchema.safeParse(parsed);
  return validation.success ? validation.data : null;
}

/**
 * Backward-compat single-pair helper (used in legacy callsites + tests).
 * В новом flow — `generateTieredQA` + emit три line per concept.
 */
async function generateQAPair(
  provider: LLMProvider,
  model: string,
  delta: DeltaKnowledge,
  signal?: AbortSignal,
): Promise<QAPair | null> {
  const tiered = await generateTieredQA(provider, model, delta, signal);
  return tiered ? tiered.t2_applied : null;
}

function buildShareGptLine(
  line: JsonlLine,
  qa: QAPair,
  tier: DifficultyTier = "t2",
): ShareGptLine {
  const systemValue = `You are an expert in ${line.delta.domain}.`;
  return {
    conversations: [
      { from: "system", value: systemValue },
      { from: "human", value: qa.question },
      { from: "gpt", value: qa.answer },
    ],
    metadata: {
      conceptId: line.conceptId,
      bookId: line.bookId,
      collectionName: line.collectionName,
      createdAt: line.createdAt,
      domain: line.delta.domain,
      auraFlags: line.delta.auraFlags,
      tier,
    },
  };
}

/**
 * Generate all three tier lines for one source concept.
 */
function buildTieredLines(line: JsonlLine, tiered: TieredQA): ShareGptLine[] {
  return [
    buildShareGptLine(line, tiered.t1_surface, "t1"),
    buildShareGptLine(line, tiered.t2_applied, "t2"),
    buildShareGptLine(line, tiered.t3_synthesis, "t3"),
  ];
}

/* ─── Jaccard dedup ─────────────────────────────────────────────── */

/**
 * Word-level Jaccard similarity. Простая бесплатная фильтрация
 * near-duplicates без embedder. Threshold tuning:
 *   - 0.85: aggressive, drops ~15-30% on cohesive corpora.
 *   - 0.92: balanced (recommended), drops 5-15%.
 *   - 0.97: lenient, only exact rephrasings.
 *
 * Не filter'ит cross-tier sample'ы одного concept'а — они by design
 * имеют overlap в terminology, но разные framing.
 */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter((w) => w.length >= 3); // skip "in", "a", "the", "и", "не"
  return new Set(words);
}

export function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DedupResult {
  kept: ShareGptLine[];
  dropped: number;
}

/**
 * Dedup ShareGptLine[] by question similarity. Groups by tier — мы
 * не хотим filter'ить T1 vs T3 same-concept (они by design разные
 * framing на one knowledge).
 *
 * threshold = 0.92 default (balanced, drops 5-15% обычно).
 */
export function dedupShareGptLines(
  lines: ShareGptLine[],
  threshold = 0.92,
): DedupResult {
  /** @type {Map<DifficultyTier, ShareGptLine[]>} */
  const byTier = new Map<DifficultyTier, ShareGptLine[]>();
  for (const line of lines) {
    const tier = line.metadata.tier;
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier)!.push(line);
  }
  const kept: ShareGptLine[] = [];
  let dropped = 0;
  for (const [, group] of byTier) {
    /** @type {ShareGptLine[]} */
    const tierKept: ShareGptLine[] = [];
    for (const candidate of group) {
      const candQ = candidate.conversations.find((c) => c.from === "human")?.value ?? "";
      const isDupe = tierKept.some((existing) => {
        const existQ = existing.conversations.find((c) => c.from === "human")?.value ?? "";
        return jaccardSimilarity(candQ, existQ) > threshold;
      });
      if (isDupe) dropped += 1;
      else tierKept.push(candidate);
    }
    kept.push(...tierKept);
  }
  return { kept, dropped };
}

export interface ShareGptBuildOptions extends IterateOptions {
  onProgress?: (done: number, total: number) => void;
  /** When true — generate all three tiers per concept (default).
   *  When false — only T2 applied. */
  multiTier?: boolean;
  /** Jaccard threshold для dedup. Default 0.92. Set 0 to skip dedup. */
  dedupThreshold?: number;
}

/**
 * Buffer all ShareGPT lines в RAM. С multi-tier enabled — output
 * size = concept_count × 3 ≈ 3KB × 3 = 9KB per concept. Streaming
 * (Phase 8d) уже работает в build-bridge.ts; этот buffer-helper
 * сохранён для тестов + alternate flows.
 */
export async function buildShareGptBuffer(opts: ShareGptBuildOptions): Promise<{
  jsonl: string;
  lineCount: number;
  warnings: string[];
  dropped: number;
}> {
  const warnings: string[] = [];
  const multiTier = opts.multiTier !== false;
  const dedupThreshold = opts.dedupThreshold ?? 0.92;

  const sourceLines: JsonlLine[] = [];
  for await (const line of iterateAcceptedConcepts({
    ...opts,
    onWarning: (w) => warnings.push(w),
  })) {
    sourceLines.push(line);
  }
  if (sourceLines.length === 0) {
    return { jsonl: "", lineCount: 0, warnings, dropped: 0 };
  }

  const allLines: ShareGptLine[] = [];
  let processed = 0;
  await withProvider(opts.userId, "crystallizer", async (provider, model) => {
    for (const src of sourceLines) {
      if (opts.signal?.aborted) break;
      try {
        const tiered = await generateTieredQA(provider, model, src.delta, opts.signal);
        if (!tiered) {
          warnings.push(`concept ${src.conceptId}: tiered QA generation failed`);
          continue;
        }
        if (multiTier) {
          allLines.push(...buildTieredLines(src, tiered));
        } else {
          allLines.push(buildShareGptLine(src, tiered.t2_applied, "t2"));
        }
      } catch (err) {
        warnings.push(
          `concept ${src.conceptId}: synthesizer threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        processed += 1;
        opts.onProgress?.(processed, sourceLines.length);
      }
    }
  });

  const { kept, dropped } =
    dedupThreshold > 0 && dedupThreshold < 1
      ? dedupShareGptLines(allLines, dedupThreshold)
      : { kept: allLines, dropped: 0 };

  const outLines = kept.map((line) => JSON.stringify(line));
  return {
    jsonl: outLines.join("\n") + (outLines.length > 0 ? "\n" : ""),
    lineCount: outLines.length,
    warnings,
    dropped,
  };
}

/* Pure helpers for tests + build-bridge reuse. */
export {
  QAPairSchema,
  TieredQASchema,
  type QAPair,
  type TieredQA,
  buildShareGptLine,
  buildTieredLines,
  generateQAPair,
  generateTieredQA,
};
