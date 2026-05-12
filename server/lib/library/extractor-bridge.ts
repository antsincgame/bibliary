import { ID, Permission, Role } from "node-appwrite";

import { BUCKETS, COLLECTIONS, getAppwrite, isAppwriteCode } from "../appwrite.js";
import { extractChapter } from "../llm/extractor.js";
import { summarizeUnit } from "../llm/summarizer.js";
import { publishUser } from "../realtime/event-bus.js";
import { buildConceptEmbedText, embedPassage } from "../embedder/index.js";
import {
  deleteAllChunksForBook,
  insertChunk,
  linkChunkSiblings,
  setParentForChunks,
} from "../vectordb/chunks.js";
import {
  findSimilarConcepts,
  insertConceptVector,
  type SimilarConceptRow,
} from "../vectordb/concepts.js";
import {
  deleteGraphForBook,
  getEntitiesForBookRegistry,
  ingestRelations,
} from "../vectordb/graph.js";
import { cleanChapterParagraphs } from "./chunk-cleanup.js";
import {
  chunkSections,
  iterateExtractionUnits,
  iterateMarkdownSections,
  type SectionAwareChunk,
} from "./chunker.js";
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
/** Phase Δe — propositions are LAZY: only extracted for books that
 * passed the evaluator with score ≥ this. Sub-threshold books still
 * get full L1+L2 extraction; we just don't pay for the fine-grain
 * L0 layer on them. */
const L0_QUALITY_THRESHOLD = 7;
import type { DeltaKnowledge, TopologyRelation } from "../../../shared/llm/extractor-schema.js";

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
  /** Phase Δc — distinct entities newly seen during this run. */
  entitiesTouched?: number;
  /** Phase Δc — total relations inserted into the graph. */
  relationsInserted?: number;
  /** Phase Δe — L0 atomic propositions persisted (≥7 quality books only). */
  propositionsInserted?: number;
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
 * Phase Δe — build a natural-language proposition from a topology
 * triple. Predicate underscores get spaced (`launched_with` →
 * "launched with") so the embedder sees a real sentence. Output is
 * trimmed and capped at 400 chars (defensive against pathological
 * LLM emissions).
 */
function buildPropositionText(rel: TopologyRelation): string {
  const subj = rel.subject.trim();
  const pred = rel.predicate.trim().replace(/_/g, " ");
  const obj = rel.object.trim();
  return `${subj} ${pred} ${obj}.`.slice(0, 400);
}

/**
 * Phase Δe — embed every relation triple of an accepted delta as an
 * L0 proposition. Parent points up at the L1 chunk that produced the
 * delta so retrieval can walk L0 → L1 for context expansion. We dedup
 * propositions within the delta by their text to avoid storing the
 * same triple twice when the LLM repeats itself.
 *
 * Returns the count of inserted L0 rows so the caller can roll it
 * into stats. Embedder failures only warn — extraction has already
 * succeeded by this point.
 */
async function embedAndStorePropositions(
  userId: string,
  bookId: string,
  parentChunkRowId: number | null,
  delta: DeltaKnowledge,
  onWarning: (msg: string) => void,
): Promise<number> {
  const seen = new Set<string>();
  let inserted = 0;
  for (let i = 0; i < delta.relations.length; i++) {
    const rel = delta.relations[i];
    const text = buildPropositionText(rel);
    if (text.length < 10) continue; // garbage triple
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const embedding = await embedPassage(text);
      insertChunk({
        userId,
        bookId,
        level: 0,
        embedding,
        text,
        pathTitles: [], // propositions are not chapter-bound
        sectionLevel: 0,
        sectionOrder: 0,
        partN: i + 1,
        partOf: delta.relations.length,
        parentVecRowId: parentChunkRowId,
      });
      inserted += 1;
    } catch (err) {
      onWarning(
        `L0 proposition embed/insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return inserted;
}

/**
 * Phase Δb — embed every L1 section chunk and persist to chunks +
 * chunks_vec BEFORE extraction. Returns the rowids of the inserted
 * chunks (1:1 with input order) so the caller can later link siblings,
 * back-reference from concepts, or use as parents for L0 propositions.
 *
 * Embedder failures degrade gracefully: a chunk whose embedding throws
 * is skipped (we record a warning) but extraction still proceeds — the
 * narrative pipeline doesn't depend on chunks being vectorized.
 */
async function embedAndStoreChunks(
  userId: string,
  bookId: string,
  chunks: SectionAwareChunk[],
  onWarning: (msg: string) => void,
): Promise<Array<number | null>> {
  const rowIds: Array<number | null> = [];
  for (const chunk of chunks) {
    try {
      const embedding = await embedPassage(chunk.text);
      const rowid = insertChunk({
        userId,
        bookId,
        level: 1,
        embedding,
        text: chunk.text,
        pathTitles: chunk.pathTitles,
        sectionLevel: chunk.sectionLevel,
        sectionOrder: chunk.sectionOrder,
        partN: chunk.partN,
        partOf: chunk.partOf,
      });
      rowIds.push(rowid);
    } catch (err) {
      onWarning(
        `chunk embed failed (${err instanceof Error ? err.message : String(err)})`,
      );
      rowIds.push(null);
    }
  }
  /* Link siblings within the same section. We group by sectionOrder
   * because cross-section sibling links would distort tree-proximity
   * scoring later (Δf). */
  const bySection = new Map<number, number[]>();
  for (let i = 0; i < chunks.length; i++) {
    const rowid = rowIds[i];
    if (rowid === null) continue;
    const key = chunks[i].sectionOrder;
    const arr = bySection.get(key) ?? [];
    arr.push(rowid);
    bySection.set(key, arr);
  }
  for (const arr of bySection.values()) {
    if (arr.length > 1) linkChunkSiblings(arr);
  }
  return rowIds;
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

  /* Phase Δa — section-aware split. Each unit = H1/H2 root + its H3+
   * descendants. Every emitted chunk carries pathTitles breadcrumb so
   * the crystallizer prompt can disambiguate ("Part II > Ch 3 > §2"
   * NOT just "§2"). LLM cost stays at one extractChapter() call per
   * unit — same grain as legacy chapter loop.
   *
   * Risk-register streaming fix: use the generator pair so peak RAM
   * is O(largest unit), not O(whole book). Sections + their wrappers
   * are GC'd as soon as the unit they feed into is processed. */
  const unitsIter = iterateExtractionUnits(iterateMarkdownSections(markdown));

  /* Phase Δb — re-extraction must not leave stale L1 chunks behind. If
   * this book was already extracted (e.g. user clicked Crystallize a
   * second time), wipe its chunks rows + vectors so the freshly
   * embedded set is the only one queryable. Concepts dedup separately
   * via Phase 10c. */
  const purgedChunks = deleteAllChunksForBook(userId, bookId);
  /* Phase Δc — purge stale graph for this book too. Orphan entities
   * (no surviving relation) are swept inside deleteGraphForBook. */
  const purgedGraph = deleteGraphForBook(userId, bookId);

  const accumulatedWarnings: string[] = [];
  if (purgedChunks > 0) {
    accumulatedWarnings.push(`pre-extract: purged ${purgedChunks} stale chunks`);
  }
  if (purgedGraph.relationsDeleted > 0) {
    accumulatedWarnings.push(
      `pre-extract: purged ${purgedGraph.relationsDeleted} stale relations, ${purgedGraph.entitiesDeleted} orphan entities`,
    );
  }
  let chaptersProcessed = 0;
  let chunksTotal = 0;
  let conceptsAccepted = 0;
  let conceptsFailed = 0;
  let entitiesTouched = 0;
  let relationsInserted = 0;
  let propositionsInserted = 0;

  /* Phase Δe — gate L0 propositions on book quality. Books not yet
   * evaluated (qualityScore === null) are below threshold by default,
   * so the user can extract first / evaluate later and re-extract to
   * get the L0 layer. isFictionOrWater === true bypasses the layer
   * regardless of numeric score. */
  const l0Enabled =
    typeof book.qualityScore === "number" &&
    book.qualityScore >= L0_QUALITY_THRESHOLD &&
    book.isFictionOrWater !== true;
  if (!l0Enabled) {
    accumulatedWarnings.push(
      `L0 propositions disabled (qualityScore=${book.qualityScore ?? "null"}, isFictionOrWater=${book.isFictionOrWater ?? "null"})`,
    );
  }

  let i = -1;
  for (const unit of unitsIter) {
    i += 1;
    if (opts.signal?.aborted) break;
    /* Phase 8e: strip metadata noise (page markers, ISBN/copyright,
     * decorative dividers, repeated running headers, footnote markers)
     * ПЕРЕД chunking. «Плод знаний без шелухи» → больше signal на
     * tokens budget. Cleanup is per-section so heading inheritance
     * across H3 children isn't disturbed. */
    const cleanedSections = unit.sections.map((s) => ({
      ...s,
      paragraphs: cleanChapterParagraphs(s.paragraphs),
    }));
    const rawChunks = chunkSections(cleanedSections);
    /* Phase 8e: token budget guard. */
    const chunks: SectionAwareChunk[] = rawChunks.map((chunk) => ({
      partN: chunk.partN,
      text: trimToTokenBudget(chunk.text, CHUNK_TOKEN_BUDGET).text,
      pathTitles: chunk.pathTitles,
      sectionLevel: chunk.sectionLevel,
      sectionOrder: chunk.sectionOrder,
      partOf: chunk.partOf,
    }));
    chunksTotal += chunks.length;
    if (chunks.length === 0) {
      chaptersProcessed += 1;
      continue;
    }

    /* Phase Δb — embed + persist every L1 chunk BEFORE LLM extraction.
     * Pre-persist so a mid-extraction crash leaves the chunk tree
     * intact for resume; the queue can rerun extractChapter without
     * re-embedding. Failures here only warn — we still extract.
     * rowIds parallels chunks[]: rowIds[i] is the chunks_vec.rowid of
     * chunks[i], or null if embed failed. */
    const rowIds = await embedAndStoreChunks(userId, bookId, chunks, (msg) =>
      accumulatedWarnings.push(`unit-${i}: ${msg}`),
    );

    publishUser(userId, "extractor_events:created", {
      bookId,
      event: "started",
      payload: {
        kind: "chapter",
        chapterIndex: i,
        chapterTitle: unit.thesisTitle,
        breadcrumb: unit.rootPath,
        chunkCount: chunks.length,
      },
    });

    /* Phase Δa: prefer the full breadcrumb as thesis context when
     * available (e.g. "Part II > Chapter 7" instead of bare "Chapter 7"),
     * which disambiguates duplicate titles repeated across a book. */
    const thesis = unit.rootPath.length > 1
      ? unit.rootPath.join(" > ")
      : unit.thesisTitle;
    const result = await extractChapter(
      userId,
      {
        chapterThesis: thesis,
        chunks: chunks.map(({ partN, text }) => ({ partN, text })),
      },
      opts.signal ? { signal: opts.signal } : {},
    );
    accumulatedWarnings.push(
      ...result.warnings.map((w) => `unit-${i}: ${w}`),
    );

    /* Phase Δc — persist concept AND ingest its relations into the
     * graph keyed by the chunk that produced them. perChunk[k] is the
     * extraction outcome for chunks[k]; rowIds[k] is its vec rowid.
     * We iterate perChunk so dedup-skipped deltas don't pollute graph
     * counts but ACCEPTED deltas still contribute their topology. */
    for (let k = 0; k < result.perChunk.length; k++) {
      const pc = result.perChunk[k];
      if (!pc.delta) continue;
      const sourceChunkRowId = rowIds[k] ?? null;
      try {
        const persisted = await persistConcept(userId, bookId, collection, pc.delta);
        if (persisted.persisted) conceptsAccepted += 1;
        else if (persisted.dedupSkipped) {
          accumulatedWarnings.push(
            `unit-${i}: semantic dedup skipped (cosine > ${DEDUP_SIMILARITY_THRESHOLD})`,
          );
        } else conceptsFailed += 1;
        /* Even dedup-skipped concepts contribute relations to the
         * graph — the topology is shared knowledge, only the dataset
         * line is suppressed. */
        try {
          const ingested = ingestRelations({
            userId,
            bookId,
            triples: pc.delta.relations,
            sourceChunkVecRowId: sourceChunkRowId,
          });
          entitiesTouched += ingested.entitiesTouched;
          relationsInserted += ingested.relationsInserted;
        } catch (err) {
          accumulatedWarnings.push(
            `unit-${i}: graph ingest failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        /* Phase Δe — proposition layer for high-quality books. Skipped
         * if (qualityScore < 7) OR (isFictionOrWater === true) OR
         * not yet evaluated. We pass parent = the L1 chunk that
         * produced this delta so retrieval can hop L0 → L1 freely. */
        if (l0Enabled) {
          try {
            const n = await embedAndStorePropositions(
              userId,
              bookId,
              sourceChunkRowId,
              pc.delta,
              (msg) => accumulatedWarnings.push(`unit-${i}: ${msg}`),
            );
            propositionsInserted += n;
          } catch (err) {
            accumulatedWarnings.push(
              `unit-${i}: L0 batch failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        conceptsFailed += 1;
        accumulatedWarnings.push(
          `unit-${i}: persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    /* Phase Δd — L2 chapter summary. Synthesize a short throughline
     * over the essences accepted in this unit, embed it, store as
     * level=2 chunk, and reparent the L1 children to it. Failure
     * (LLM unavailable, schema-empty result) only warns; the L1 tree
     * stays parent-less but still queryable. */
    const acceptedEssences = result.perChunk
      .map((pc) => pc.delta?.essence)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    let l2Rowid: number | null = null;
    if (!opts.signal?.aborted) {
      try {
        const summary = await summarizeUnit(
          userId,
          { breadcrumb: unit.rootPath, essences: acceptedEssences },
          opts.signal ? { signal: opts.signal } : {},
        );
        accumulatedWarnings.push(
          ...summary.warnings.map((w) => `unit-${i}: ${w}`),
        );
        if (summary.text) {
          const embedding = await embedPassage(summary.text);
          l2Rowid = insertChunk({
            userId,
            bookId,
            level: 2,
            embedding,
            text: summary.text,
            pathTitles: unit.rootPath,
            sectionLevel: unit.rootLevel,
            sectionOrder: unit.rootOrder,
            partN: 1,
            partOf: 1,
          });
          /* Reparent L1 children to the L2 summary. rowIds[] still maps
           * to chunks[]; filter out embed-failed nulls. */
          const childRowIds = rowIds.filter((r): r is number => r !== null);
          if (childRowIds.length > 0) {
            setParentForChunks(childRowIds, l2Rowid);
          }
        }
      } catch (err) {
        accumulatedWarnings.push(
          `unit-${i}: L2 summary failed: ${err instanceof Error ? err.message : String(err)}`,
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
        chapterTitle: unit.thesisTitle,
        breadcrumb: unit.rootPath,
        l2Rowid,
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
      entitiesTouched,
      relationsInserted,
      propositionsInserted,
      usingFallback: aggregatedFallback,
    },
  });

  /* Suppress unused — registry helper is consumed by Δd L2 summarizer;
   * importing here so the symbol stays in the bridge's view. */
  void getEntitiesForBookRegistry;

  return {
    ok: conceptsAccepted > 0,
    bookId,
    chaptersProcessed,
    chunksTotal,
    conceptsAccepted,
    conceptsFailed,
    entitiesTouched,
    relationsInserted,
    propositionsInserted,
    warnings: accumulatedWarnings,
  };
}
