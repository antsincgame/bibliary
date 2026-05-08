import type { BookCatalogMeta, BookStatus } from "./types.js";
import { getStoredOriginalFileName } from "./storage-contract.js";

export interface BookRow {
  id: string;
  sha256: string;
  title: string;
  author: string | null;
  title_ru: string | null;
  author_ru: string | null;
  title_en: string | null;
  author_en: string | null;
  year: number | null;
  isbn: string | null;
  publisher: string | null;
  word_count: number;
  chapter_count: number;
  original_format: string;
  source_archive: string | null;
  sphere: string | null;
  domain: string | null;
  quality_score: number | null;
  conceptual_density: number | null;
  originality: number | null;
  is_fiction_or_water: number | null;
  verdict_reason: string | null;
  evaluator_reasoning: string | null;
  evaluator_model: string | null;
  evaluated_at: string | null;
  concepts_extracted: number | null;
  concepts_accepted: number | null;
  concepts_deduped: number | null;
  /** Иt 8Г.2: общее число semantic chunks подано на extraction. */
  chunks_total: number | null;
  /** Иt 8Г.2: JSON-снимок chunker-провенанса (TEXT). */
  chunker_provenance: string | null;
  uniqueness_score: number | null;
  uniqueness_novel_count: number | null;
  uniqueness_total_ideas: number | null;
  uniqueness_evaluated_at: string | null;
  uniqueness_error: string | null;
  status: string;
  last_error: string | null;
  md_path: string;
}

export function rowToMeta(
  row: BookRow,
  tagsEn: string[],
  tagsRu: string[] = [],
): BookCatalogMeta & { mdPath: string } {
  const originalFormat = row.original_format as BookCatalogMeta["originalFormat"];
  return {
    id: row.id,
    sha256: row.sha256,
    title: row.title,
    author: row.author ?? undefined,
    titleRu: row.title_ru ?? undefined,
    authorRu: row.author_ru ?? undefined,
    titleEn: row.title_en ?? undefined,
    authorEn: row.author_en ?? undefined,
    year: row.year ?? undefined,
    isbn: row.isbn ?? undefined,
    publisher: row.publisher ?? undefined,
    wordCount: row.word_count,
    chapterCount: row.chapter_count,
    originalFile: getStoredOriginalFileName(originalFormat),
    originalFormat,
    sourceArchive: row.source_archive ?? undefined,
    sphere: row.sphere ?? undefined,
    domain: row.domain ?? undefined,
    tags: tagsEn.length > 0 ? tagsEn : undefined,
    tagsRu: tagsRu.length > 0 ? tagsRu : undefined,
    qualityScore: row.quality_score ?? undefined,
    conceptualDensity: row.conceptual_density ?? undefined,
    originality: row.originality ?? undefined,
    isFictionOrWater: row.is_fiction_or_water === null ? undefined : row.is_fiction_or_water === 1,
    verdictReason: row.verdict_reason ?? undefined,
    evaluatorReasoning: row.evaluator_reasoning ?? undefined,
    evaluatorModel: row.evaluator_model ?? undefined,
    evaluatedAt: row.evaluated_at ?? undefined,
    conceptsExtracted: row.concepts_extracted ?? undefined,
    conceptsAccepted: row.concepts_accepted ?? undefined,
    conceptsDeduped: row.concepts_deduped ?? undefined,
    chunksTotal: row.chunks_total ?? undefined,
    chunkerProvenance: row.chunker_provenance ?? undefined,
    uniquenessScore: row.uniqueness_score ?? undefined,
    uniquenessNovelCount: row.uniqueness_novel_count ?? undefined,
    uniquenessTotalIdeas: row.uniqueness_total_ideas ?? undefined,
    uniquenessEvaluatedAt: row.uniqueness_evaluated_at ?? undefined,
    uniquenessError: row.uniqueness_error ?? undefined,
    status: row.status as BookStatus,
    lastError: row.last_error ?? undefined,
    mdPath: row.md_path,
  };
}

export interface CatalogQuery {
  search?: string;
  minQuality?: number;
  maxQuality?: number;
  hideFictionOrWater?: boolean;
  statuses?: BookStatus[];
  domain?: string;
  /** Сортировка заголовка с учётом языка UI (`ru` → RU-зеркало первым). */
  displayLocale?: "ru" | "en";
  orderBy?: "quality" | "title" | "words" | "evaluated";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  rows: (BookCatalogMeta & { mdPath: string })[];
  total: number;
}

export interface RevisionDedupBook {
  id: string;
  title: string;
  author?: string;
  titleEn?: string;
  authorEn?: string;
  titleRu?: string;
  authorRu?: string;
  sourceArchive?: string;
  year?: number;
  isbn?: string;
}
