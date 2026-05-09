/**
 * Uniqueness step внутри evaluator-queue pipeline.
 *
 * Вынесено из evaluator-queue.ts (раньше inline-блок ~45 строк). Чистая
 * функция: принимает уже-оценённую книгу + chapters + signal, ничего не
 * возвращает — мутирует BookCatalogMeta через upsertBook + persistFrontmatter.
 *
 * Никогда не throw'ает: если uniqueness падает / aborted / pref выключен —
 * quality eval результат уже сохранён выше в pipeline, мы только пропускаем
 * uniqueness. Это явный контракт: uniqueness НЕ должен валить evaluator-queue.
 */

import { readPipelinePrefsOrNull } from "../preferences/store.js";
import type { BookCatalogMeta, ConvertedChapter } from "./types.js";

export interface RunUniquenessStepArgs {
  /** Метаданные книги после quality-eval (передаётся в vectordb как baseline). */
  baseMeta: BookCatalogMeta;
  /** Главы книги (parsed из book.md). */
  chapters: ConvertedChapter[];
  /** Путь к book.md для persist'а frontmatter. */
  mdPath: string;
  /** Сырой markdown — нужен persistFrontmatter для замены frontmatter блока. */
  md: string;
  /** Reasoning от evaluator'а — попадает в Evaluator Reasoning section. */
  reasoning: string | null | undefined;
  /** Slot abort signal — должен прокинуться в LLM/vectordb вызовы. */
  signal: AbortSignal;
  /** Persist callback — реальный wrapper над frontmatter writer. */
  persistFrontmatter: (
    meta: BookCatalogMeta,
    mdPath: string,
    md: string,
    reasoning?: string | null,
  ) => Promise<void>;
  /** SQLite upsert callback — пробрасываем для тестируемости. */
  upsertBook: (meta: BookCatalogMeta, mdPath: string) => void;
}

/**
 * Прогоняет uniqueness eval поверх свежеоценённой книги. На любой сбой —
 * console.warn и тихий return; pipeline идёт дальше с qualityScore'ом
 * сохранённым ранее. Pref `uniquenessEvaluationEnabled` отключает шаг
 * без следов в логах.
 */
export async function runUniquenessStep(args: RunUniquenessStepArgs): Promise<void> {
  try {
    const prefs = await readPipelinePrefsOrNull();
    if (!prefs?.uniquenessEvaluationEnabled || args.signal.aborted) return;

    const { evaluateBookUniqueness } = await import("./uniqueness-evaluator.js");
    const { DEFAULT_COLLECTION } = await import("../../ipc/dataset-v2-ipc-state.js");
    const { getReaderModel } = await import("../llm/model-resolver.js");

    const reader = await getReaderModel();
    if (!reader) return; /* нет загруженной модели — пропускаем без warning */

    /* Fix-while-touching (Phase 2): раньше тут был хардкод DEFAULT_COLLECTION
     * без оглядки на пользовательскую конфигурацию dataset-v2. Если юзер
     * extract'ит в `marketing-concepts`, а uniqueness читает `delta-knowledge`
     * — score становится бессмысленным (сравниваем с чужим корпусом).
     * Теперь читаем из prefs.uniquenessTargetCollection; пустая строка
     * fallback'ится на DEFAULT_COLLECTION (= back-compat поведение). */
    const targetCollection = prefs.uniquenessTargetCollection?.trim() || DEFAULT_COLLECTION;

    const unique = await evaluateBookUniqueness(args.chapters, {
      modelKey: reader.modelKey,
      targetCollection,
      similarityHigh: prefs.uniquenessSimilarityHigh,
      similarityLow: prefs.uniquenessSimilarityLow,
      ideasPerChapterMax: prefs.uniquenessIdeasPerChapterMax,
      chapterParallel: prefs.uniquenessChapterParallel,
      mergeThreshold: prefs.uniquenessMergeThreshold,
      signal: args.signal,
    });

    const withUniqueness: BookCatalogMeta = {
      ...args.baseMeta,
      uniquenessScore: unique.score,
      uniquenessNovelCount: unique.novelCount,
      uniquenessTotalIdeas: unique.totalIdeas,
      uniquenessEvaluatedAt: new Date().toISOString(),
      uniquenessError: unique.error,
    };
    args.upsertBook(withUniqueness, args.mdPath);
    await args.persistFrontmatter(withUniqueness, args.mdPath, args.md, args.reasoning);
  } catch (err) {
    console.warn(`[evaluator-queue] uniqueness skipped:`, err instanceof Error ? err.message : err);
  }
}
