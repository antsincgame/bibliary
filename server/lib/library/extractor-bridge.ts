import { ID, Permission, Role } from "node-appwrite";

import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode } from "../appwrite.js";
import { extractChapter } from "../llm/extractor.js";
import { publishUser } from "../realtime/event-bus.js";
import { chunkChapter, splitMarkdownIntoChapters } from "./chunker.js";
import {
  getBookById,
  updateBook,
} from "./repository.js";
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

async function persistConcept(
  userId: string,
  bookId: string,
  collectionName: string,
  delta: DeltaKnowledge,
): Promise<boolean> {
  const { databases, databaseId } = getAppwrite();
  const nowIso = new Date().toISOString();
  /* Payload — full DeltaKnowledge JSON (для downstream synthesis +
   * UI inspection). Cap по size attribute (20000 в bootstrap). */
  const payload = JSON.stringify(delta).slice(0, CONCEPT_PAYLOAD_MAX_CHARS);
  try {
    await databases.createDocument(
      databaseId,
      COLLECTIONS.concepts,
      ID.unique(),
      {
        userId,
        bookId,
        collectionName,
        payload,
        accepted: true,
        /* vectorRowId оставляем не выставленным — Phase 7 worker
         * embed'нет и поставит rowid в sqlite-vec concepts_vec. */
        createdAt: nowIso,
      },
      [
        Permission.read(Role.user(userId)),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
        Permission.read(Role.team("admin")),
      ],
    );
    return true;
  } catch (err) {
    /* Дубликаты по vectorRowId возможны при retry — игнорируем 409. */
    if (isAppwriteCode(err, 409)) return false;
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
    const chunks = chunkChapter({
      paragraphs: ch.paragraphs,
      chapterTitle: ch.chapterTitle,
    });
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
        const persisted = await persistConcept(userId, bookId, collection, delta);
        if (persisted) conceptsAccepted += 1;
        else conceptsFailed += 1;
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
