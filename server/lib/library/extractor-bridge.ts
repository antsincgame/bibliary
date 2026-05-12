import { ID, Permission, Role } from "node-appwrite";

import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode } from "../appwrite.js";
import { extractChapter } from "../llm/extractor.js";
import { publishUser } from "../realtime/event-bus.js";
import { buildConceptEmbedText, embedPassage } from "../embedder/index.js";
import {
  findSimilarConcepts,
  insertConceptVector,
  type SimilarConceptRow,
} from "../vectordb/concepts.js";
import { cleanChapterParagraphs } from "./chunk-cleanup.js";
import { chunkChapter, splitMarkdownIntoChapters } from "./chunker.js";
import {
  getBookById,
  updateBook,
} from "./repository.js";
import { trimToTokenBudget } from "./token-budget.js";

/** Per-chunk budget — соответствует .claude/rules/02-extraction.md
 * "Для коротких chunks (<300 токенов) — 3B+ thinking", "Для длинных
 * (>800) — 14B+". Стартуем с 2000 cap для safety: даже худшие книги
 * с длинными абзацами умещаются, и нет риска полу-предложений
 * обрезанных в самом интересном месте. */
const CHUNK_TOKEN_BUDGET = 2000;

/** Phase 10c: cross-collection semantic dedup threshold. Cosine
 * similarity > 0.9 = "this delta is essentially same as existing".
 * Conservative — 0.92 был бы too aggressive для legitimately rephrased
 * insights, 0.85 пропустил бы near-duplicates. 0.9 — компромисс из
 * Magpie research recommendations. */
const DEDUP_SIMILARITY_THRESHOLD = 0.9;
import type { DeltaKnowledge } from "../../../shared/llm/extractor-schema.js";

/**
 * Bridge Phase 6e: full delta-knowledge extraction для одной книги.
 *
 *   1. Load book document + markdown bytes из Appwrite Storage
 *   2. splitMarkdownIntoChapters → ChapterBlock[]
 *   3. Для каждой главы: chunkChapter → extractChapter (per-chunk через
 *      withProvider) → ChapterExtractionResult.accepted: DeltaKnowledge[]
 *   4. Каждая DeltaKnowledge → document в `concepts` Appwrite collection
 *      с per-user permissions (Phase 5 isolation).
 *   5. SSE events на каждом этапе чтобы renderer показал progress.
 *
 * Phase 7 worker queue заменит inline awaits на async background job;
 * пока — sync execution (caller ждёт N×LLM latency × chunks).
 */

export interface ExtractBookResult {
  ok: boolean;
  bookId: string;
  chaptersProcessed: number;
  chunksTotal: number;
  conceptsAccepted: number;
  conceptsFailed: number;
  warnings: string[];
  error?: string;
}

const COLLECTION_NAME_DEFAULT = "default";
const CONCEPT_PAYLOAD_MAX_CHARS = 19_000; // collection field size cap from bootstrap

async function loadMarkdown(bucketId: string, fileId: string): Promise<string> {
  const { storage } = getAppwrite();
  const view = await storage.getFileDownload(bucketId, fileId);
  const bytes = view instanceof Uint8Array ? view : new Uint8Array(view as ArrayBuffer);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Phase 10b: embed delta + INSERT в sqlite-vec → возвращает rowid.
 * Если embedder упал (network / cold-start timeout), возвращаем null
 * и concept всё равно persistится (без vectorRowId) — semantic
 * features degrade gracefully, dataset export по-прежнему работает.
 */
async function embedAndStore(
  userId: string,
  bookId: string,
  collectionName: string,
  delta: DeltaKnowledge,
): Promise<{ rowid: number; embedding: Float32Array } | null> {
  try {
    const text = buildConceptEmbedText(delta);
    const embedding = await embedPassage(text);
    const rowid = insertConceptVector({
      userId,
      bookId,
      collectionName,
      embedding,
    });
    return { rowid, embedding };
  } catch (err) {
    console.warn(
      `[extractor-bridge] embed failed for concept (${err instanceof Error ? err.message : err}); persisting без vectorRowId`,
    );
    return null;
  }
}

/**
 * Phase 10c: cross-collection semantic dedup. Если уже есть accepted
 * concept в той же user+collection partition с cosine > threshold →
 * return existing rowid + indicate skip. Caller записывает warning
 * вместо create.
 */
function checkSemanticDuplicate(
  userId: string,
  collectionName: string,
  embedding: Float32Array,
): SimilarConceptRow | null {
  try {
    const similar = findSimilarConcepts({
      userId,
      collectionName,
      embedding,
      limit: 1,
      minSimilarity: DEDUP_SIMILARITY_THRESHOLD,
    });
    return similar[0] ?? null;
  } catch (err) {
    console.warn(
      `[extractor-bridge] dedup search failed (${err instanceof Error ? err.message : err}); proceeding без dedup`,
    );
    return null;
  }
}

async function persistConcept(
  userId: string,
  bookId: string,
  collectionName: string,
  delta: DeltaKnowledge,
): Promise<{ persisted: boolean; dedupSkipped: boolean }> {
  /* Phase 10b: embed first, потому что результат нужен и для dedup,
   * и для vectorRowId на create document. */
  const embeddedResult = await embedAndStore(userId, bookId, collectionName, delta);

  /* Phase 10c: если embedding получен, semantic dedup pass ДО create.
   * Optimization: insertConceptVector выше уже добавил наш own vector —
   * теперь findSimilar найдёт его как nearest (distance 0). Нужно
   * исключить self-match. */
  let dedupSkipped = false;
  if (embeddedResult) {
    const similar = checkSemanticDuplicate(
      userId,
      collectionName,
      embeddedResult.embedding,
    );
    /* similar.rowid === embeddedResult.rowid когда match — это наш свежий.
     * Real duplicate: similar.rowid OTHER than just-inserted. */
    if (similar && similar.rowid !== embeddedResult.rowid) {
      dedupSkipped = true;
      /* Откатываем insert — мы скопировали существующий concept. */
      try {
        const { deleteConceptVector } = await import("../vectordb/concepts.js");
        deleteConceptVector(embeddedResult.rowid);
      } catch {
        /* swallow — orphan vector не критично */
      }
      return { persisted: false, dedupSkipped: true };
    }
  }

  const { databases, databaseId } = getAppwrite();
  const nowIso = new Date().toISOString();
  const payload = JSON.stringify(delta).slice(0, CONCEPT_PAYLOAD_MAX_CHARS);
  try {
    const doc: Record<string, unknown> = {
      userId,
      bookId,
      collectionName,
      payload,
      accepted: true,
      createdAt: nowIso,
    };
    if (embeddedResult) {
      doc["vectorRowId"] = embeddedResult.rowid;
    }
    await databases.createDocument(
      databaseId,
      COLLECTIONS.concepts,
      ID.unique(),
      doc,
      [
        Permission.read(Role.user(userId)),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
        Permission.read(Role.team("admin")),
      ],
    );
    return { persisted: true, dedupSkipped };
  } catch (err) {
    /* Дубликаты по vectorRowId возможны при retry — игнорируем 409. */
    if (isAppwriteCode(err, 409)) return { persisted: false, dedupSkipped };
    throw err;
  }
}

export async function extractBookViaBridge(
  userId: string,
  bookId: string,
  opts: { collection?: string; signal?: AbortSignal } = {},
): Promise<ExtractBookResult> {
  const collection = opts.collection ?? COLLECTION_NAME_DEFAULT;
  const book = await getBookById(userId, bookId);
  if (!book) {
    return {
      ok: false,
      bookId,
      chaptersProcessed: 0,
      chunksTotal: 0,
      conceptsAccepted: 0,
      conceptsFailed: 0,
      warnings: [],
      error: "book_not_found",
    };
  }
  if (!book.markdownFileId) {
    return {
      ok: false,
      bookId,
      chaptersProcessed: 0,
      chunksTotal: 0,
      conceptsAccepted: 0,
      conceptsFailed: 0,
      warnings: [],
      error: "markdown_not_available",
    };
  }

  await updateBook(userId, bookId, { status: "crystallizing" });
  publishUser(userId, "extractor_events:created", {
    bookId,
    event: "started",
    payload: { kind: "extraction", collection },
  });

  let markdown: string;
  try {
    markdown = await loadMarkdown(BUCKETS.bookMarkdowns, book.markdownFileId);
  } catch (err) {
    const msg = isAppwriteCode(err, 404)
      ? "markdown_file_missing"
      : err instanceof Error ? err.message : String(err);
    await updateBook(userId, bookId, { status: "failed" });
    publishUser(userId, "extractor_events:created", {
      bookId,
      event: "failed",
      payload: { reason: msg },
    });
    return {
      ok: false,
      bookId,
      chaptersProcessed: 0,
      chunksTotal: 0,
      conceptsAccepted: 0,
      conceptsFailed: 0,
      warnings: [],
      error: msg,
    };
  }

  const chapters = splitMarkdownIntoChapters(markdown);
  const accumulatedWarnings: string[] = [];
  let chaptersProcessed = 0;
  let chunksTotal = 0;
  let conceptsAccepted = 0;
  let conceptsFailed = 0;

  for (let i = 0; i < chapters.length; i++) {
    if (opts.signal?.aborted) break;
    const ch = chapters[i];
    /* Phase 8e: strip metadata noise (page markers, ISBN/copyright,
     * decorative dividers, repeated running headers, footnote markers)
     * ПЕРЕД chunking. «Плод знаний без шелухи» → больше signal на
     * tokens budget. */
    const cleanedParagraphs = cleanChapterParagraphs(ch.paragraphs);
    const rawChunks = chunkChapter({
      paragraphs: cleanedParagraphs,
      chapterTitle: ch.chapterTitle,
    });
    /* Phase 8e: token budget guard. Если chunk превышает CHUNK_TOKEN_BUDGET,
     * trim at sentence boundary — LLM context window saved + per-chunk
     * focus retained. */
    const chunks = rawChunks.map((chunk) => ({
      ...chunk,
      text: trimToTokenBudget(chunk.text, CHUNK_TOKEN_BUDGET).text,
    }));
    chunksTotal += chunks.length;
    if (chunks.length === 0) {
      chaptersProcessed += 1;
      continue;
    }
    publishUser(userId, "extractor_events:created", {
      bookId,
      event: "started",
      payload: {
        kind: "chapter",
        chapterIndex: i,
        chapterTitle: ch.chapterTitle,
        chunkCount: chunks.length,
      },
    });

    const result = await extractChapter(
      userId,
      {
        /* Используем chapterTitle как thesis MVP — Phase 6f добавит
         * pre-pass через provider.chat для нормального chapter thesis. */
        chapterThesis: ch.chapterTitle,
        chunks,
      },
      opts.signal ? { signal: opts.signal } : {},
    );
    accumulatedWarnings.push(
      ...result.warnings.map((w) => `chapter-${i}: ${w}`),
    );

    for (const delta of result.accepted) {
      try {
        const result = await persistConcept(userId, bookId, collection, delta);
        if (result.persisted) conceptsAccepted += 1;
        else if (result.dedupSkipped) {
          accumulatedWarnings.push(
            `chapter-${i}: semantic dedup skipped (cosine > ${DEDUP_SIMILARITY_THRESHOLD})`,
          );
        } else conceptsFailed += 1;
      } catch (err) {
        conceptsFailed += 1;
        accumulatedWarnings.push(
          `chapter-${i}: persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    chaptersProcessed += 1;
    publishUser(userId, "extractor_events:created", {
      bookId,
      event: "done",
      payload: {
        kind: "chapter",
        chapterIndex: i,
        chapterTitle: ch.chapterTitle,
        stats: result.stats,
      },
    });
  }

  const finalStatus = conceptsAccepted > 0 ? "indexed" : "failed";
  await updateBook(userId, bookId, { status: finalStatus });
  /* Aggregate fallback hint — true если хотя бы один chunk шёл fallback. */
  const aggregatedFallback = accumulatedWarnings.some((w) =>
    w.includes("using LM Studio fallback"),
  );
  publishUser(userId, "extractor_events:created", {
    bookId,
    event: "done",
    payload: {
      kind: "extraction",
      chaptersProcessed,
      chunksTotal,
      conceptsAccepted,
      conceptsFailed,
      usingFallback: aggregatedFallback,
    },
  });

  return {
    ok: conceptsAccepted > 0,
    bookId,
    chaptersProcessed,
    chunksTotal,
    conceptsAccepted,
    conceptsFailed,
    warnings: accumulatedWarnings,
  };
}
