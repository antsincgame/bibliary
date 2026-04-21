/**
 * Stage 4 — LLM-as-Judge + Cross-Library Dedup.
 *
 * Перед LLM (дёшево):
 *   - embed principle → Qdrant search в коллекции `dataset-accepted-concepts`
 *     с filter по `domain`. Если top-1 score > 0.85 → автодубликат, отбросить.
 *
 * Если прошёл — LLM-судья оценивает по 3 осям:
 *   - novelty (для опытного практика)
 *   - actionability (можно применить?)
 *   - domain_fit (соответствие заявленному domain)
 *
 * weighted score = 0.5*novelty + 0.3*actionability + 0.2*domain_fit
 * Threshold 0.6 (configurable).
 *
 * Принятые → upsert в Qdrant (positive feedback loop для следующих книг).
 */

import { promises as fs } from "fs";
import * as path from "path";
import { embedQuery } from "../rag/index.js";
import { fetchQdrantJson, QDRANT_URL, QDRANT_API_KEY } from "../qdrant/http-client.js";
import { EMBEDDING_DIM } from "../scanner/embedding.js";
import { JudgeResultSchema, type AcceptedConcept, type DedupedConcept, type JudgeResult } from "./types.js";

export const ACCEPTED_COLLECTION = "dataset-accepted-concepts";
const CROSS_LIB_DUPE_THRESHOLD = 0.85;
const DEFAULT_SCORE_THRESHOLD = 0.6;

export interface JudgeCallbacks {
  llm: (args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<string>;
  onEvent?: (e: JudgeEvent) => void;
}

export type JudgeEvent =
  | { type: "judge.crossdupe"; principle: string; existingId: string; sim: number }
  | { type: "judge.score"; principle: string; score: number; novelty: number; actionability: number; domain_fit: number }
  | { type: "judge.reject.lowscore"; principle: string; score: number; reason: string }
  | { type: "judge.reject.error"; principle: string; reason: string }
  | { type: "judge.accept"; principle: string; score: number };

const PROMPT_CACHE: { template: string | null } = { template: null };

function bundledJudgeCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.BIBLIARY_PROMPTS_DEFAULT_DIR) {
    candidates.push(path.join(process.env.BIBLIARY_PROMPTS_DEFAULT_DIR, "concept-judge.md"));
  }
  if (typeof __dirname !== "undefined") {
    candidates.push(path.resolve(__dirname, "..", "..", "defaults", "prompts", "concept-judge.md"));
  }
  candidates.push(path.resolve(process.cwd(), "electron", "defaults", "prompts", "concept-judge.md"));
  return candidates;
}

async function loadPromptTemplate(promptsDir: string | null): Promise<string> {
  if (PROMPT_CACHE.template) return PROMPT_CACHE.template;
  if (promptsDir) {
    try {
      const userText = await fs.readFile(path.join(promptsDir, "concept-judge.md"), "utf8");
      if (userText.trim().length > 50) {
        PROMPT_CACHE.template = userText;
        return userText;
      }
    } catch {
      /* fallback */
    }
  }
  for (const candidate of bundledJudgeCandidates()) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      if (text.trim().length > 50) {
        PROMPT_CACHE.template = text;
        return text;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error("concept-judge.md not found in any default location");
}

export function clearJudgePromptCache(): void {
  PROMPT_CACHE.template = null;
}

/* ────────────────── Cross-library check + collection management ────────────────── */

async function ensureAcceptedCollection(): Promise<void> {
  try {
    await fetchQdrantJson(`${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}`);
    return;
  } catch {
    /* probe failed — try create (404 ловится в catch как HTTP, не differentiation) */
  }
  try {
    await fetchQdrantJson(`${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
    });
    /* best-effort indexes */
    for (const field of ["domain", "tags", "bookSourcePath"]) {
      await fetchQdrantJson(`${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}/index`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
      }).catch(() => undefined);
    }
  } catch (e) {
    /* Если не смогли создать — это критично, пробрасываем */
    throw new Error(`failed to ensure accepted collection: ${e instanceof Error ? e.message : e}`);
  }
}

interface CrossSearchHit {
  id: string;
  score: number;
}

async function crossLibrarySearch(domain: string, vector: number[]): Promise<CrossSearchHit | null> {
  await ensureAcceptedCollection();
  const data = await fetchQdrantJson<{ result: Array<{ id: string | number; score: number }> }>(
    `${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}/points/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit: 1,
        with_payload: false,
        filter: { must: [{ key: "domain", match: { value: domain } }] },
      }),
    }
  );
  if (data.result.length === 0) return null;
  const top = data.result[0];
  return { id: String(top.id), score: top.score };
}

async function upsertAccepted(concept: AcceptedConcept, vector: number[]): Promise<void> {
  await ensureAcceptedCollection();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
  const resp = await fetch(`${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}/points?wait=true`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      points: [
        {
          id: concept.id,
          vector,
          payload: {
            principle: concept.principle,
            explanation: concept.explanation,
            domain: concept.domain,
            tags: concept.tags,
            noveltyHint: concept.noveltyHint,
            sourceQuote: concept.sourceQuote,
            bookSourcePath: concept.bookSourcePath,
            bookTitle: concept.bookTitle,
            chapterIndex: concept.chapterIndex,
            chapterTitle: concept.chapterTitle,
            judgeScore: concept.judgeScore,
            judgeReasoning: concept.judgeReasoning,
            scoreBreakdown: concept.scoreBreakdown,
            acceptedAt: concept.acceptedAt,
          },
        },
      ],
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`accepted upsert ${resp.status}: ${txt.slice(0, 200)}`);
  }
}

/* ────────────────── Judge LLM call ────────────────── */

function tryParseJudgeJson(raw: string): unknown {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
  return JSON.parse(cleaned);
}

async function llmJudge(
  concept: DedupedConcept,
  template: string,
  cb: JudgeCallbacks
): Promise<JudgeResult | null> {
  const conceptForLlm = {
    principle: concept.principle,
    explanation: concept.explanation,
    domain: concept.domain,
    tags: concept.tags,
    noveltyHint: concept.noveltyHint,
  };
  const prompt = template.replace("{{CONCEPT_JSON}}", JSON.stringify(conceptForLlm, null, 2));
  let raw: string;
  try {
    raw = await cb.llm({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxTokens: 800,
    });
  } catch (e) {
    cb.onEvent?.({ type: "judge.reject.error", principle: concept.principle.slice(0, 60), reason: e instanceof Error ? e.message : String(e) });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = tryParseJudgeJson(raw);
  } catch (e) {
    cb.onEvent?.({ type: "judge.reject.error", principle: concept.principle.slice(0, 60), reason: `parse: ${e}` });
    return null;
  }
  const result = JudgeResultSchema.safeParse(parsed);
  if (!result.success) {
    cb.onEvent?.({ type: "judge.reject.error", principle: concept.principle.slice(0, 60), reason: `schema: ${result.error.message.slice(0, 100)}` });
    return null;
  }
  return result.data;
}

function weightedScore(j: JudgeResult): number {
  return 0.5 * j.novelty + 0.3 * j.actionability + 0.2 * j.domain_fit;
}

/* ────────────────── Main entry ────────────────── */

export interface JudgeBatchArgs {
  concepts: DedupedConcept[];
  promptsDir?: string | null;
  callbacks: JudgeCallbacks;
  scoreThreshold?: number;
  crossLibDupeThreshold?: number;
}

export interface JudgeBatchResult {
  accepted: AcceptedConcept[];
  rejected: Array<{ concept: DedupedConcept; reason: string }>;
}

export async function judgeAndAccept(args: JudgeBatchArgs): Promise<JudgeBatchResult> {
  const template = await loadPromptTemplate(args.promptsDir ?? null);
  const threshold = args.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const crossTh = args.crossLibDupeThreshold ?? CROSS_LIB_DUPE_THRESHOLD;

  const accepted: AcceptedConcept[] = [];
  const rejected: Array<{ concept: DedupedConcept; reason: string }> = [];

  for (const concept of args.concepts) {
    const vector = await embedQuery(concept.principle);

    /* 1. Cross-library check (бесплатно, без LLM) */
    let crossHit: CrossSearchHit | null = null;
    try {
      crossHit = await crossLibrarySearch(concept.domain, vector);
    } catch {
      /* if Qdrant down — skip cross-check, доверяем LLM */
    }
    if (crossHit && crossHit.score > crossTh) {
      args.callbacks.onEvent?.({
        type: "judge.crossdupe",
        principle: concept.principle.slice(0, 60),
        existingId: crossHit.id,
        sim: crossHit.score,
      });
      rejected.push({ concept, reason: `cross-library duplicate of ${crossHit.id} (sim=${crossHit.score.toFixed(3)})` });
      continue;
    }

    /* 2. LLM judge */
    const judgeResult = await llmJudge(concept, template, args.callbacks);
    if (!judgeResult) {
      rejected.push({ concept, reason: "judge-error" });
      continue;
    }
    const score = weightedScore(judgeResult);
    args.callbacks.onEvent?.({
      type: "judge.score",
      principle: concept.principle.slice(0, 60),
      score,
      novelty: judgeResult.novelty,
      actionability: judgeResult.actionability,
      domain_fit: judgeResult.domain_fit,
    });

    if (score < threshold) {
      args.callbacks.onEvent?.({
        type: "judge.reject.lowscore",
        principle: concept.principle.slice(0, 60),
        score,
        reason: judgeResult.reasoning,
      });
      rejected.push({ concept, reason: `low score ${score.toFixed(3)} < ${threshold}: ${judgeResult.reasoning}` });
      continue;
    }

    /* 3. Accept + upsert */
    const acceptedConcept: AcceptedConcept = {
      ...concept,
      judgeScore: score,
      judgeReasoning: judgeResult.reasoning,
      acceptedAt: new Date().toISOString(),
      scoreBreakdown: {
        novelty: judgeResult.novelty,
        actionability: judgeResult.actionability,
        domain_fit: judgeResult.domain_fit,
      },
    };
    try {
      await upsertAccepted(acceptedConcept, vector);
    } catch (e) {
      rejected.push({ concept, reason: `upsert-error: ${e instanceof Error ? e.message : e}` });
      continue;
    }
    args.callbacks.onEvent?.({ type: "judge.accept", principle: concept.principle.slice(0, 60), score });
    accepted.push(acceptedConcept);
  }

  return { accepted, rejected };
}
