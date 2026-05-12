import { BUCKETS, getAppwrite, isAppwriteCode } from "../appwrite.js";
import { evaluateBook } from "../llm/evaluator.js";
import { publishUser } from "../realtime/event-bus.js";
import {
  getBookById,
  updateBook,
  type BookDoc,
} from "./repository.js";

/**
 * Bridge от Appwrite `books` document → server-side evaluator →
 * persistence обратно в `books`. Используется из POST /api/library/books/:id/evaluate.
 *
 * Поток:
 *   1. Загрузить book document (через user-scope в repository.ts)
 *   2. Получить markdown text из bucket `book-markdowns`
 *   3. Построить «surrogate» (Phase 6c MVP — урезанный markdown без
 *      полного surrogate-builder)
 *   4. evaluateBook(userId, surrogate) → ServerEvaluationResult
 *   5. Записать score / tags / metadata в book document, статус
 *      → "evaluated" или "failed"
 *   6. publishUser → SSE → renderer обновляет catalog row
 */

export interface EvaluateBookBridgeResult {
  ok: boolean;
  bookId: string;
  evaluation?: BookDoc | null;
  warnings: string[];
  error?: string;
}

/**
 * Дешёвый poor-man surrogate: первые ~6000 символов markdown. Не
 * выкидывает frontmatter (LLM сам игнорирует YAML). Phase 7+ заменит
 * на полноценный structural surrogate с TOC + intro + nodal slices.
 */
const SURROGATE_MAX_CHARS = 6000;

function buildSurrogate(markdown: string): string {
  if (markdown.length <= SURROGATE_MAX_CHARS) return markdown;
  /* Берём начало (frontmatter + intro) — там обычно метаданные. */
  return markdown.slice(0, SURROGATE_MAX_CHARS);
}

async function loadMarkdown(bucketId: string, fileId: string): Promise<string> {
  const { storage } = getAppwrite();
  const view = await storage.getFileDownload(bucketId, fileId);
  const bytes = view instanceof Uint8Array ? view : new Uint8Array(view as ArrayBuffer);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function evaluateBookViaBridge(
  userId: string,
  bookId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<EvaluateBookBridgeResult> {
  const book = await getBookById(userId, bookId);
  if (!book) {
    return { ok: false, bookId, warnings: [], error: "book_not_found" };
  }
  if (!book.markdownFileId) {
    return { ok: false, bookId, warnings: [], error: "markdown_not_available" };
  }

  publishUser(userId, "evaluator_events:created", {
    bookId,
    event: "started",
  });
  await updateBook(userId, bookId, { status: "evaluating" });

  let markdown: string;
  try {
    markdown = await loadMarkdown(BUCKETS.bookMarkdowns, book.markdownFileId);
  } catch (err) {
    const msg = isAppwriteCode(err, 404)
      ? "markdown_file_missing"
      : err instanceof Error ? err.message : String(err);
    await updateBook(userId, bookId, { status: "failed" });
    publishUser(userId, "evaluator_events:created", {
      bookId,
      event: "failed",
      payload: { reason: msg },
    });
    return { ok: false, bookId, warnings: [], error: msg };
  }

  const surrogate = buildSurrogate(markdown);
  const result = await evaluateBook(userId, surrogate, opts.signal ? { signal: opts.signal } : {});

  if (!result.evaluation) {
    await updateBook(userId, bookId, { status: "failed", evaluatorModel: result.model });
    publishUser(userId, "evaluator_events:created", {
      bookId,
      event: "failed",
      payload: { warnings: result.warnings },
    });
    return { ok: false, bookId, warnings: result.warnings, error: "evaluation_failed" };
  }

  const ev = result.evaluation;
  const updated = await updateBook(userId, bookId, {
    title: ev.title_en,
    titleRu: ev.title_ru,
    author: ev.author_en,
    authorRu: ev.author_ru,
    year: ev.year,
    domain: ev.domain,
    tags: ev.tags,
    tagsRu: ev.tags_ru,
    isFictionOrWater: ev.is_fiction_or_water,
    conceptualDensity: ev.conceptual_density,
    originality: ev.originality,
    qualityScore: ev.quality_score,
    verdictReason: ev.verdict_reason,
    evaluatorModel: result.model,
    evaluatedAt: new Date().toISOString(),
    status: "evaluated",
  });

  publishUser(userId, "evaluator_events:created", {
    bookId,
    event: "done",
    payload: {
      qualityScore: ev.quality_score,
      isFictionOrWater: ev.is_fiction_or_water,
      domain: ev.domain,
      usingFallback: result.usingFallback,
    },
  });

  return { ok: true, bookId, evaluation: updated, warnings: result.warnings };
}
