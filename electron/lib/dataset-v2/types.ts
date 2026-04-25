/**
 * Dataset v2 типы — Delta-Knowledge Pipeline.
 *
 * Единый пайплайн: чанкинг → AURA-фильтр → DeltaKnowledge → Qdrant.
 * Один чанк = 0 или 1 запись в Qdrant.
 */
import { z } from "zod";

/** Чанк с breadcrumb-контекстом для delta-extractor. */
export interface SemanticChunk {
  /** Текст для LLM (без breadcrumb-обёртки — обёртка в `breadcrumb`). */
  text: string;
  /**
   * Структурированный контекст (JSON): bookTitle, chapter, subHeading, part.
   * Extractor подставляет его в промпт как {{BREADCRUMB}}.
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

export interface ChapterMemory {
  ledEssences: string[];
  lastThesis: string;
}

/* ─────────────── AURA filter flags ─────────────── */

/** A.У.Р.А. — четыре критерия уникальности знания. Min 2 из 4 для прохождения. */
export type AuraFlag =
  | "authorship"      // A — Авторский концепт: новая модель/формула/классификация
  | "specialization"  // У — Узкая специализация: deep technical/scientific nuances
  | "revision"        // Р — Разрушение мифов: опровергает default LLM knowledge
  | "causality";      // А — Причинно-следственная механика: скрытое "почему"

export const AURA_FLAGS: readonly AuraFlag[] = [
  "authorship", "specialization", "revision", "causality",
] as const;

/* ─────────────── DeltaKnowledge — единый выходной тип ─────────────── */

export const DeltaKnowledgeSchema = z.object({
  domain: z.string().min(2).max(60),
  chapterContext: z.string().min(10).max(300),
  essence: z.string().min(30).max(800),
  cipher: z.string().min(5).max(500),
  proof: z.string().min(10).max(800),
  applicability: z.string().max(500).default(""),
  auraFlags: z.array(z.enum(["authorship", "specialization", "revision", "causality"])).min(2).max(4),
  tags: z.array(z.string().min(1).max(40)).min(1).max(10),
});

export interface DeltaKnowledge extends z.infer<typeof DeltaKnowledgeSchema> {
  /** SHA1 id, deterministic from chunk source identity. */
  id: string;
  bookSourcePath: string;
  bookTitle: string;
  chapterIndex: number;
  acceptedAt: string;
}

/* ─────────────── Backward-compat: re-export assertValidCollectionName ─────────────── */

const COLLECTION_NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;

export function assertValidCollectionName(name: string): void {
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new Error(`Invalid collection name: "${name}". Must match ${COLLECTION_NAME_RE}`);
  }
}
