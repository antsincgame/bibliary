import { z } from "zod";

import { withProvider } from "../llm/model-resolver.js";
import type { LLMProvider } from "../llm/provider.js";
import type { DeltaKnowledge } from "../../../shared/llm/extractor-schema.js";
import { iterateAcceptedConcepts, type IterateOptions, type JsonlLine } from "./synthesize.js";

/**
 * Phase 8b — ShareGPT synthesizer. Переиспользуем `crystallizer` role
 * (она же synthesizer per user's mental model): тот же LLM который
 * умеет выделять delta из chunk умеет породить Q&A pair из delta.
 *
 * Single Q&A per concept в MVP — "applied" difficulty (T2 в legacy
 * терминологии). Surface (T1) и synthesis (T3) добавим в follow-up если
 * метрики покажут пользу.
 *
 * Cost / time:
 *   - One LLM call per concept ~3-15s (Claude Sonnet) или 30-60s
 *     (LM Studio local). 100 concepts = ~10 min.
 *   - Prompt caching: system prompt + delta — оба cached в Anthropic;
 *     incremental cost dominated by output tokens.
 */

const QASchema = z.object({
  question: z.string().min(20).max(800),
  answer: z.string().min(40).max(2000),
});

type QAPair = z.infer<typeof QASchema>;

const SYSTEM_PROMPT = `You are a dataset synthesizer for fine-tuning LLM. Given a delta-knowledge atom (essence + cipher + proof + relations), generate ONE applied Q&A pair that teaches this knowledge.

Rules:
1. The QUESTION must test applied understanding, not recall. Use scenarios, comparisons, or "why/how" framing — NOT "what is X".
2. The ANSWER must be derived from the delta's essence + proof. Include the cipher / formula if numeric. Mention relations subject/object if useful.
3. English only. No markdown fences. No mention of "the delta" or "the source" — answer as if you're an expert on the topic directly.
4. Question length: 1-3 sentences. Answer length: 1-2 paragraphs.

Output STRICT JSON: {"question": "...", "answer": "..."}`;

const USER_PROMPT_TEMPLATE = (delta: DeltaKnowledge): string =>
  `Domain: ${delta.domain}

Chapter context: ${delta.chapterContext}

Essence: ${delta.essence}

Cipher: ${delta.cipher}

Proof: ${delta.proof}

${delta.applicability ? `Applicability: ${delta.applicability}\n\n` : ""}Relations:
${delta.relations.map((r) => `  - ${r.subject} ${r.predicate} ${r.object}`).join("\n")}

Generate the Q&A pair.`;

export interface ShareGptLine {
  conversations: Array<{ from: "system" | "human" | "gpt"; value: string }>;
  metadata: {
    conceptId: string;
    bookId: string;
    collectionName: string;
    createdAt: string;
    domain: string;
    auraFlags: string[];
  };
}

const QA_MAX_TOKENS = 1024;
const QA_TEMPERATURE = 0.5;

async function generateQAPair(
  provider: LLMProvider,
  model: string,
  delta: DeltaKnowledge,
  signal?: AbortSignal,
): Promise<QAPair | null> {
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
  /* Strip markdown fences if модель не послушалась */
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
  const validation = QASchema.safeParse(parsed);
  return validation.success ? validation.data : null;
}

function buildShareGptLine(line: JsonlLine, qa: QAPair): ShareGptLine {
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
    },
  };
}

export interface ShareGptBuildOptions extends IterateOptions {
  onProgress?: (done: number, total: number) => void;
}

/**
 * Buffer all ShareGPT lines в RAM — for ≤100 concepts. Streaming
 * variant потребуется когда extraction накопит >5K concepts на user'а.
 */
export async function buildShareGptBuffer(opts: ShareGptBuildOptions): Promise<{
  jsonl: string;
  lineCount: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  /* First pass — collect all source lines (cheap, only Appwrite query). */
  const sourceLines: JsonlLine[] = [];
  for await (const line of iterateAcceptedConcepts({
    ...opts,
    onWarning: (w) => warnings.push(w),
  })) {
    sourceLines.push(line);
  }
  if (sourceLines.length === 0) {
    return { jsonl: "", lineCount: 0, warnings };
  }

  /* Second pass — LLM Q&A через crystallizer role. Per-line failure
   * isolated (одна неудача не блокирует 999 остальных). */
  const outLines: string[] = [];
  let processed = 0;
  await withProvider(opts.userId, "crystallizer", async (provider, model) => {
    for (const src of sourceLines) {
      if (opts.signal?.aborted) break;
      try {
        const qa = await generateQAPair(provider, model, src.delta, opts.signal);
        if (!qa) {
          warnings.push(`concept ${src.conceptId}: QA pair generation failed`);
          continue;
        }
        outLines.push(JSON.stringify(buildShareGptLine(src, qa)));
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

  return {
    jsonl: outLines.join("\n") + (outLines.length > 0 ? "\n" : ""),
    lineCount: outLines.length,
    warnings,
  };
}

/* Pure helpers for tests + build-bridge reuse. */
export { QASchema, type QAPair, buildShareGptLine, generateQAPair };
