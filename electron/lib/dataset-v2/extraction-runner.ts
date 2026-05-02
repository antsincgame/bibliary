/**
 * Single-book Delta-Knowledge extraction runner.
 *
 * Извлечён из `electron/ipc/dataset-v2.ipc.ts` (Phase 3.2 cross-platform
 * roadmap, 2026-04-30) — рядом с уже выделенным `batch-runner.ts`. IPC-handler
 * стал тонкой обёрткой; gate/cancel/error-recovery логика тестируется без
 * `ipcMain`.
 *
 * Public API:
 *   - `runExtraction(args, emit)` — основной entry-point
 *   - `StartExtractionArgs` / `StartExtractionResult` — публичные типы
 */

import { randomUUID } from "crypto";
import { parseBook } from "../scanner/parsers/index.js";
import { isOcrSupported } from "../scanner/ocr/index.js";
import {
  chunkChapter,
  extractDeltaKnowledge,
  assertValidCollectionName,
  isNonContentSection,
  type DeltaExtractEvent,
} from "./index.js";
import { extractChapterThesis } from "./delta-extractor.js";
import { embedPassage } from "../embedder/shared.js";
import { chatWithPolicy, PROFILE } from "../../lmstudio-client.js";
import { getPreferencesStore } from "../preferences/store.js";
import { resolveCrystallizerModelKey } from "../llm/model-role-resolver.js";
import { filterOrderedCandidatesAgainstLoaded } from "../llm/with-model-fallback.js";
import { coordinator } from "../resilience/batch-coordinator.js";
import {
  trackExtractionJob,
  untrackExtractionJob,
} from "./coordinator-pipeline.js";
import { getModelProfile } from "./model-profile.js";
import { buildDeltaKnowledgeResponseFormat } from "./json-schemas.js";
import { ALLOWED_DOMAINS } from "../../crystallizer-constants.js";
import { getModelPool } from "../llm/model-pool.js";
import { activeJobs, DEFAULT_COLLECTION } from "../../ipc/dataset-v2-ipc-state.js";

export interface StartExtractionArgs {
  bookSourcePath: string;
  /** Optional: индексы глав для обработки (по умолчанию — все). */
  chapterRange?: { from: number; to: number };
  /** Override модели (по умолчанию — BIG profile). */
  extractModel?: string;
  /**
   * Имя Qdrant-коллекции, куда уходят принятые концепты + где
   * выполняется cross-library dedup. Если не указано — `DEFAULT_COLLECTION`.
   */
  targetCollection?: string;
  /**
   * Иt 8Г.3: stable book identifier (UUID/SHA-derived) для:
   *   - payload Qdrant (более стабильный ключ чем bookSourcePath, который
   *     может меняться при перемещении файла);
   *   - delete-on-reimport: перед upsert новых точек книги — удалить старые
   *     `must.bookId === args.bookId` (нет orphan vectors при reimport).
   *
   * Optional для backward-compat: legacy callers (одиночный extract по
   * пути без каталога) могут опустить — тогда bookId не пишется и
   * delete-on-reimport не выполняется.
   */
  bookId?: string;
}

export interface StartExtractionResult {
  jobId: string;
  bookTitle: string;
  totalChapters: number;
  processedChapters: number;
  totalDelta: { chunks: number; accepted: number; skipped: number };
  warnings: string[];
}

/** Primary + CSV fallbacks, deduped (prefs order preserved). */
function buildDeltaExtractorModelChain(primary: string, fallbackCsv: string): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  add(primary);
  for (const p of fallbackCsv.split(",").map((x) => x.trim()).filter(Boolean)) add(p);
  return out;
}

/**
 * Delta-Knowledge LLM wrapper — single role, unified pipeline.
 */
function makeLlm(
  modelKey: string,
  signal: AbortSignal,
): (args: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
}) => Promise<{ content: string; reasoningContent?: string }> {
  const profilePromise = getModelProfile(modelKey);
  const allowedDomains = Array.from(ALLOWED_DOMAINS).sort();

  /* ModelPool integration (2026-04-30): каждый chat-вызов оборачивается в
     pool.withModel() — это гарантирует что модель загружена в LM Studio
     перед чатом и refCount учитывается. Pool сам решит выгружать ли LRU.
     При cross-model fallback (delta-extractor) каждая модель из chain
     попадает сюда отдельно, и pool правильно зарегистрирует refCount
     на каждом ключе. */
  return async ({ messages, temperature, maxTokens }) => {
    const profile = await profilePromise;
    const callerHint = maxTokens ?? 4096;
    const effectiveMaxTokens = Math.max(callerHint, profile.maxTokens);

    return getModelPool().withModel(
      modelKey,
      { role: "crystallizer", ttlSec: 1800, gpuOffload: "max" },
      async () => {
        const response = await chatWithPolicy(
          {
            model: modelKey,
            messages,
            sampling: {
              temperature: temperature ?? 0.3,
              top_p: 0.9,
              top_k: 30,
              min_p: 0,
              presence_penalty: 0,
              max_tokens: effectiveMaxTokens,
            },
            stop: profile.stop,
            responseFormat: profile.useResponseFormat
              ? buildDeltaKnowledgeResponseFormat(allowedDomains)
              : undefined,
            chatTemplateKwargs: profile.chatTemplateKwargs,
          },
          { externalSignal: signal },
        );
        return { content: response.content, reasoningContent: response.reasoningContent };
      },
    );
  };
}

/**
 * Core extraction routine. Используется и `dataset-v2:start-extraction`
 * (single book), и `dataset-v2:start-batch` (multi-book queue из Library).
 * Получает emit() от caller'а -- это позволяет batch wrapper'у добавлять
 * свой `batchId`/`bookIndex` к каждому событию.
 */
export async function runExtraction(
  args: StartExtractionArgs,
  emit: (event: Record<string, unknown>) => void,
): Promise<StartExtractionResult> {
  if (!args || typeof args.bookSourcePath !== "string") throw new Error("bookSourcePath required");

  const targetCollection = args.targetCollection ?? DEFAULT_COLLECTION;
  assertValidCollectionName(targetCollection);

  const jobId = randomUUID();
  const ctrl = new AbortController();
  activeJobs.set(jobId, ctrl);
  trackExtractionJob(jobId, ctrl);
  coordinator.reportBatchStart({
    pipeline: "extraction",
    batchId: jobId,
    startedAt: new Date().toISOString(),
    config: { bookSourcePath: args.bookSourcePath, extractModel: args.extractModel, targetCollection },
  });

  const emitWithJob = (event: Record<string, unknown>): void => emit({ jobId, ...event });
  /* Цепочка выбора:
       1. явный override от UI (args.extractModel)
       2. prefs.extractorModel + fallback chain (через role-resolver)
       3. PROFILE.BIG.key как последний рубеж */
  let extractModel = args.extractModel;
  if (!extractModel) {
    try {
      const resolved = await resolveCrystallizerModelKey();
      if (resolved?.modelKey) extractModel = resolved.modelKey;
    } catch (e) {
      console.warn(`[extraction] role-resolver failed, falling back to PROFILE.BIG: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!extractModel) extractModel = PROFILE.BIG.key;

  const llm = makeLlm(extractModel, ctrl.signal);

  emitWithJob({ stage: "config", phase: "info", extractModel, targetCollection });

  const prefs = await getPreferencesStore().getAll();
  const rawDeltaChain = buildDeltaExtractorModelChain(extractModel, prefs.extractorModelFallbacks ?? "");
  const extractionDeltaModelChain = await filterOrderedCandidatesAgainstLoaded("crystallizer", rawDeltaChain);
  emitWithJob({
    stage: "config",
    phase: "delta-models",
    extractModel,
    extractModelChain: extractionDeltaModelChain,
    rawDeltaChain,
    deltaCrossModel: extractionDeltaModelChain.length > 1,
  });
  console.log(
    `[extraction] delta model chain (${extractionDeltaModelChain.length}): ${extractionDeltaModelChain.join(" → ")}`,
  );

  try {
    emitWithJob({ stage: "parse", phase: "start", bookSourcePath: args.bookSourcePath });
    console.log(`\n[extraction] ═══ START ═══ collection="${targetCollection}" model="${extractModel}"`);
    console.log(`[extraction] parsing: ${args.bookSourcePath}`);
    const parsed = await parseBook(args.bookSourcePath, {
      ocrEnabled: prefs.ocrEnabled && (isOcrSupported() || prefs.djvuOcrProvider !== "system"),
      ocrLanguages: prefs.ocrLanguages,
      ocrAccuracy: prefs.ocrAccuracy,
      ocrPdfDpi: prefs.ocrPdfDpi,
      djvuOcrProvider: prefs.djvuOcrProvider,
      djvuRenderDpi: prefs.djvuRenderDpi,
      visionModelKey: prefs.visionModelKey,
      signal: ctrl.signal,
    });
    const totalChapters = parsed.sections.length;
    const range = args.chapterRange ?? { from: 0, to: totalChapters };
    console.log(`[extraction] parsed "${parsed.metadata.title}" — ${totalChapters} chapters, range ${range.from}..${range.to}`);
    emitWithJob({ stage: "parse", phase: "done", bookTitle: parsed.metadata.title, totalChapters });

    const stats = { chunks: 0, accepted: 0, skipped: 0 };
    const warnings: string[] = [];
    let processed = 0;

    const { fetchQdrantJson, QDRANT_URL, deletePointsByFilter } = await import("../qdrant/http-client.js");
    const { EMBEDDING_DIM } = await import("../scanner/embedding.js");
    const { ensureQdrantCollection } = await import("../qdrant/collection-config.js");
    console.log(`[extraction] Qdrant: ${QDRANT_URL} → collection "${targetCollection}" (dim=${EMBEDDING_DIM})`);

    try {
      await ensureQdrantCollection({
        name: targetCollection,
        vectorSize: EMBEDDING_DIM,
        distance: "Cosine",
        hnsw: { m: 24, ef_construct: 128 },
        payloadIndexes: [
          { field: "bookSourcePath", type: "keyword" },
          { field: "domain", type: "keyword" },
          /* Иt 8Г.3: bookId index для O(log N) delete-by-filter и фильтра
             выборок. Безопасно для legacy коллекций — Qdrant создаёт индекс
             поверх существующих payload (поле может отсутствовать в части
             точек, индекс просто их не покрывает). */
          { field: "bookId", type: "keyword" },
        ],
      });
    } catch (createErr) {
      console.warn(`[extraction] collection create failed (will try upsert anyway): ${createErr instanceof Error ? createErr.message : createErr}`);
    }

    /* Иt 8Г.3: delete-on-reimport — удаляем точки этой книги ДО upsert
       новых, чтобы не было orphan vectors после rechunk/reextraction.
       Условие: bookId передан (новый код) — иначе legacy путь без cleanup. */
    if (args.bookId) {
      try {
        const res = await deletePointsByFilter(targetCollection, [
          { field: "bookId", value: args.bookId },
        ]);
        console.log(`[extraction] reimport cleanup: deleted points for bookId="${args.bookId}" → ${res.status}`);
      } catch (deleteErr) {
        /* Не падаем: коллекция может быть пустой или новой; upsert ниже
           всё равно поедет. Но логируем — это потенциально orphan-источник. */
        const msg = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        console.warn(`[extraction] reimport cleanup failed (continuing with upsert): ${msg}`);
        warnings.push(`reimport-cleanup-failed: ${msg.slice(0, 120)}`);
      }
    }

    for (let ci = range.from; ci < Math.min(range.to, totalChapters); ci++) {
      if (ctrl.signal.aborted) throw new Error("job aborted");
      const section = parsed.sections[ci];
      if (isNonContentSection(section)) {
        console.warn(`[extraction] ch${ci} "${section.title}" skipped as non-content section`);
        emitWithJob({ stage: "chapter", phase: "skip", chapterIndex: ci, chapterTitle: section.title, reason: "non-content-section" });
        continue;
      }

      /* Step 1 — semantic chunking */
      const chunks = await chunkChapter({
        section,
        chapterIndex: ci,
        bookTitle: parsed.metadata.title,
        bookSourcePath: args.bookSourcePath,
        signal: ctrl.signal,
        safeLimit: prefs.chunkSafeLimit,
        minChunkWords: prefs.chunkMinWords,
        driftThreshold: prefs.driftThreshold,
        maxParagraphsForDrift: prefs.maxParagraphsForDrift,
        overlapParagraphs: prefs.overlapParagraphs,
      });
      console.log(`[extraction] ch${ci} "${section.title}" → ${chunks.length} chunks (${section.paragraphs.length} paras)`);
      emitWithJob({ stage: "chunker", chapterIndex: ci, chapterTitle: section.title, chunks: chunks.length });
      if (chunks.length === 0) continue;
      stats.chunks += chunks.length;
      if (ctrl.signal.aborted) throw new Error("job aborted");

      /* Step 2 — chapter thesis (macro-context, 1 LLM call) */
      const chapterText = section.paragraphs.join("\n\n");
      const thesis = await extractChapterThesis(section.title, chapterText, { llm }, null);
      console.log(`[extraction] ch${ci} thesis: "${thesis.slice(0, 80)}…"`);
      emitWithJob({ stage: "thesis", chapterIndex: ci, thesis });
      if (ctrl.signal.aborted) throw new Error("job aborted");

      /* Step 3 — delta extraction (AURA filter + essence/cipher per chunk) */
      const useDeltaCrossModel = extractionDeltaModelChain.length > 1;
      const deltaRes = await extractDeltaKnowledge({
        chunks,
        chapterThesis: thesis,
        promptsDir: null,
        signal: ctrl.signal,
        callbacks: {
          llm,
          onEvent: (e: DeltaExtractEvent) => emitWithJob({ stage: "delta", chapterIndex: ci, ...e }),
        },
        ...(useDeltaCrossModel
          ? {
              extractModelChain: extractionDeltaModelChain,
              getLlmForModel: (mk: string) => makeLlm(mk, ctrl.signal),
            }
          : {}),
      });
      warnings.push(...deltaRes.warnings);

      for (const delta of deltaRes.accepted) {
        if (ctrl.signal.aborted) throw new Error("job aborted");
        let vector: number[];
        try {
          vector = await embedPassage(delta.essence);
        } catch (embErr) {
          const msg = embErr instanceof Error ? embErr.message : String(embErr);
          console.error(`[extraction] embedPassage FAILED for delta ${delta.id}: ${msg}`);
          warnings.push(`embed-failed: ${msg.slice(0, 120)}`);
          stats.skipped++;
          continue;
        }
        console.log(`[extraction] ✓ upsert → "${targetCollection}" id=${delta.id} domain=${delta.domain} tags=[${delta.tags.join(",")}]`);
        await fetchQdrantJson(`${QDRANT_URL}/collections/${targetCollection}/points?wait=true`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            points: [{
              id: delta.id,
              vector,
              payload: {
                domain: delta.domain,
                chapterContext: delta.chapterContext,
                essence: delta.essence,
                cipher: delta.cipher,
                proof: delta.proof,
                applicability: delta.applicability,
                auraFlags: delta.auraFlags,
                tags: delta.tags,
                /* Топологические связи (S→P→O) — для графового поиска
                 * и фильтрации по предикатам типа "depends_on", "refutes". */
                relations: delta.relations,
                bookSourcePath: delta.bookSourcePath,
                acceptedAt: delta.acceptedAt,
                /* Иt 8Г.3: stable id (UUID/SHA-derived) — выживает
                   перемещение файла, позволяет точечный delete-by-filter
                   при reimport. Optional spread: legacy callers без
                   bookId не получают ключ в payload (consistent с тем что
                   delete-on-reimport тоже пропускается). */
                ...(args.bookId ? { bookId: args.bookId } : {}),
              },
            }],
          }),
          timeoutMs: 15_000,
        });
        stats.accepted++;
        emitWithJob({
          stage: "accepted",
          conceptId: delta.id,
          principle: delta.essence,
          domain: delta.domain,
          score: 1,
          collection: targetCollection,
        });
      }
      stats.skipped += chunks.length - deltaRes.accepted.length;
      processed++;
      console.log(`[extraction] ch${ci} done: +${deltaRes.accepted.length} accepted, ${chunks.length - deltaRes.accepted.length} skipped`);

      emitWithJob({
        stage: "chapter", phase: "done", chapterIndex: ci,
        chunks: chunks.length, accepted: deltaRes.accepted.length,
        skipped: chunks.length - deltaRes.accepted.length,
      });
    }

    console.log(`[extraction] ═══ DONE ═══ "${parsed.metadata.title}" chunks=${stats.chunks} accepted=${stats.accepted} skipped=${stats.skipped} warnings=${warnings.length}`);
    emitWithJob({ stage: "job", phase: "done", stats });
    return { jobId, bookTitle: parsed.metadata.title, totalChapters, processedChapters: processed, totalDelta: stats, warnings };
  } finally {
    activeJobs.delete(jobId);
    untrackExtractionJob(jobId);
    coordinator.reportBatchEnd(jobId);
  }
}
