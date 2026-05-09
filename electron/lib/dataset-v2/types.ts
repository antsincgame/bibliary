/**
 * Dataset v2 типы — Delta-Knowledge Pipeline.
 *
 * Единый пайплайн: чанкинг → AURA-фильтр → DeltaKnowledge → vectordb.
 * Один чанк = 0 или 1 запись в vectordb.
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

/* ─────────────── Topology: Subject → Predicate → Object triple ─────────────── */

/**
 * Топологическое отношение между двумя концептами/сущностями главы.
 * Минимум 1 на чанк — это ключ к графовому поиску и связной выдаче датасета.
 *
 * predicate — это ОТНОШЕНИЕ, не глагол-связка. Запрещено: "is", "was", "has".
 * Разрешено: "designed_by", "predates", "depends_on", "refutes", "extends",
 * "applies_to", "caused_by", "translates_to", "evolved_into", "specializes",
 * "uses", "contradicts", "proven_by", "instance_of", "part_of", "limits", и т.п.
 *
 * Пример: {"subject":"Saturn V","predicate":"designed_by","object":"Wernher von Braun"}
 */
export const TopologyRelationSchema = z.object({
  subject: z.string().min(2).max(120),
  predicate: z.string().min(3).max(60).refine(
    (v) => !/^(is|was|are|were|has|have|had|be|been|will|would|do|does|did)$/i.test(v.trim()),
    { message: "predicate must be a concrete relation, not a copula (is/was/has/...)" },
  ),
  object: z.string().min(2).max(120),
});

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
  /**
   * Топология: 1-8 троек subject→predicate→object между ключевыми сущностями
   * чанка. Это превращает плоский датасет в граф знаний — позволяет искать
   * связи "X depends_on Y", строить knowledge maps, выявлять противоречия.
   * Минимум 1 связь обязательна (модель должна выделить хотя бы одну).
   *
   * NB: для backward-compat существующих записей в vectordb без relations
   * предусмотрена отдельная legacy-схема `DeltaKnowledgeLegacySchema` ниже.
   */
  relations: z.array(TopologyRelationSchema).min(1).max(8),
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
