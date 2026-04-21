/**
 * Phase 3.1 — Dataset v2 типы (контракты между ступенями кристаллизации).
 */
import { z } from "zod";

/** Чанк с breadcrumb-контекстом для concept-extractor. */
export interface SemanticChunk {
  /** Текст для LLM (без breadcrumb-обёртки — обёртка в `breadcrumb`). */
  text: string;
  /**
   * Структурированный контекст (JSON): bookTitle, chapter, subHeading, part.
   * Stage 2 (extractor) подставляет его в промпт как {{BREADCRUMB}}.
   */
  breadcrumb: string;
  partN: number;
  partTotal: number;
  chapterIndex: number;
  chapterTitle: string;
  bookTitle: string;
  bookSourcePath: string;
  wordCount: number;
  /**
   * Context overlap: последний параграф предыдущего чанка.
   * Дублируется на стыке, чтобы LLM не теряла связность.
   * Undefined для первого чанка главы.
   */
  overlapText?: string;
}

export const ExtractedConceptSchema = z.object({
  principle: z.string().min(20).max(400),
  explanation: z.string().min(80).max(1500),
  domain: z.string().min(2).max(60),
  tags: z.array(z.string().min(1).max(40)).min(1).max(10),
  noveltyHint: z.string().min(10).max(300),
  sourceQuote: z.string().min(10).max(800),
});
export type ExtractedConcept = z.infer<typeof ExtractedConceptSchema>;

export const ExtractedConceptArraySchema = z.array(ExtractedConceptSchema).max(8);

export interface ChapterMemory {
  ledConcepts: string[];
  lastSummary: string;
}

/** Концепт после Stage 3 (intra-dedup): добавляется аудит-история мерджей. */
export interface DedupedConcept extends ExtractedConcept {
  /** SHA1-id, детерминированный по principle+chapterIndex+bookSourcePath. */
  id: string;
  bookSourcePath: string;
  bookTitle: string;
  chapterIndex: number;
  chapterTitle: string;
  /** Если получился мерджем нескольких — id-исходники здесь. */
  mergedFromIds: string[];
}

/** Концепт после Stage 4 (judge + cross-library check): принят. */
export interface AcceptedConcept extends DedupedConcept {
  judgeScore: number;
  judgeReasoning: string;
  acceptedAt: string;
  scoreBreakdown: { novelty: number; actionability: number; domain_fit: number };
}

export interface JudgeResult {
  novelty: number;
  actionability: number;
  domain_fit: number;
  reasoning: string;
}

export const JudgeResultSchema = z.object({
  novelty: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  domain_fit: z.number().min(0).max(1),
  reasoning: z.string().min(10).max(800),
});
