/**
 * Pure-mapping функции evaluator-pipeline (extracted 2026-05-10 из
 * `evaluator-slot-worker.ts`).
 *
 * Самая частая регрессия в evaluator pipeline — перепутанные поля при
 * mapping'е BookEvaluation (snake_case JSON от LLM) → BookCatalogMeta
 * (camelCase для cache-db + frontmatter). Раньше этот mapping жил inline
 * в slot-worker, без возможности unit-тестировать отдельно.
 *
 * Извлечение в pure функцию даёт:
 *   - regression-страж от перепутывания qualityScore vs conceptualDensity
 *     vs originality (три похожих 0-100 поля)
 *   - явный контракт что happens при year=null (берётся from meta) и
 *     при пустых warnings
 *   - возможность тестировать через простые объекты без cache-db
 */

import type { BookCatalogMeta, BookEvaluation, EvaluationResult } from "./types.js";

export interface BuildEvaluatedMetaInput {
  /** Текущий meta из cache-db (status=imported). */
  baseMeta: BookCatalogMeta;
  /** Результат evaluator (с не-null evaluation). */
  result: EvaluationResult;
  /** ISO timestamp — обычно `new Date().toISOString()`. Параметр чтобы тест
   * мог задать стабильное значение и не зависеть от Date.now. */
  evaluatedAt: string;
}

/**
 * Применить evaluation к meta. Возвращает новый BookCatalogMeta объект
 * (immutable update), готовый к upsertBook + persistFrontmatter.
 *
 * Семантика полей:
 *   - title/author RU+EN — всегда из evaluation (LLM уже сделал транслитерацию)
 *   - year — из evaluation, иначе keep meta.year (legacy import может уже
 *     иметь year из ISBN/filename)
 *   - domain, tags, tagsRu — из evaluation
 *   - quality_score → qualityScore, conceptual_density → conceptualDensity,
 *     originality → originality (НЕ перепутать! три разных 0-100)
 *   - is_fiction_or_water → isFictionOrWater (boolean)
 *   - verdict_reason → verdictReason
 *   - evaluatorReasoning, evaluatorModel — из result (не из evaluation)
 *   - status: "evaluated" (терминальный для evaluator pipeline)
 *   - warnings: prepend prev meta warnings + append result.warnings (если есть)
 *
 * Caller гарантирует что `result.evaluation` != null (slot-worker
 * проверяет это и отдельным path обрабатывает null).
 */
export function buildEvaluatedMeta(input: BuildEvaluatedMetaInput): BookCatalogMeta {
  const { baseMeta, result, evaluatedAt } = input;
  if (!result.evaluation) {
    throw new Error("buildEvaluatedMeta: result.evaluation must not be null (caller must guard)");
  }
  const ev: BookEvaluation = result.evaluation;
  return {
    ...baseMeta,
    titleRu: ev.title_ru,
    authorRu: ev.author_ru,
    titleEn: ev.title_en,
    authorEn: ev.author_en,
    year: ev.year ?? baseMeta.year,
    domain: ev.domain,
    tags: ev.tags,
    tagsRu: ev.tags_ru,
    qualityScore: ev.quality_score,
    conceptualDensity: ev.conceptual_density,
    originality: ev.originality,
    isFictionOrWater: ev.is_fiction_or_water,
    verdictReason: ev.verdict_reason,
    evaluatorReasoning: result.reasoning ?? undefined,
    evaluatorModel: result.model,
    evaluatedAt,
    status: "evaluated",
    warnings:
      result.warnings.length > 0
        ? [...(baseMeta.warnings ?? []), ...result.warnings]
        : baseMeta.warnings,
  };
}

/**
 * Build evaluator.done event payload из evaluation.
 *
 * Извлечено вместе с buildEvaluatedMeta потому что эти две операции
 * имеют общий контракт — оба должны видеть одни и те же поля
 * BookEvaluation. Если поле переименовано в одной, должно меняться
 * в другой синхронно.
 */
export interface EvaluatorDoneEvent {
  type: "evaluator.done";
  bookId: string;
  title: string;
  qualityScore: number;
  isFictionOrWater: boolean;
  warnings?: string[];
}

export function buildEvaluatorDoneEvent(
  bookId: string,
  result: EvaluationResult,
): EvaluatorDoneEvent {
  if (!result.evaluation) {
    throw new Error("buildEvaluatorDoneEvent: result.evaluation must not be null");
  }
  const ev = result.evaluation;
  return {
    type: "evaluator.done",
    bookId,
    title: ev.title_en,
    qualityScore: ev.quality_score,
    isFictionOrWater: ev.is_fiction_or_water,
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  };
}
