/* Reuse the shared library contract so batch filtering and source paths match E2E/import. */
/**
 * Phase 3.1 — Dataset v2 IPC.
 *
 * Один публичный метод `dataset-v2:start-extraction` запускает Stages 1-4 на
 * одной книге (или диапазоне глав). Прогресс летит push-events `dataset-v2:event`
 * в renderer для alchemy log.
 *
 * Stage 5 (triplet generator) подключается в следующей итерации — accepted-concepts
 * писались в коллекцию `dataset-accepted-concepts` Qdrant как промежуточный буфер
 * для будущего v2-генератора batch-файлов (legacy v1 удалён экстерминатусом).
 */

import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import { parseBook } from "../lib/scanner/parsers/index.js";
import { isOcrSupported } from "../lib/scanner/ocr/index.js";
import {
  chunkChapter,
  extractChapterConcepts,
  dedupChapterConcepts,
  judgeAndAccept,
  ACCEPTED_COLLECTION,
  assertValidCollectionName,
  type ExtractEvent,
  type IntraDedupEvent,
  type JudgeEvent,
} from "../lib/dataset-v2/index.js";
import { chatWithPolicy, PROFILE } from "../lmstudio-client.js";
import { getPreferencesStore } from "../lib/preferences/store.js";
import { coordinator } from "../lib/resilience/batch-coordinator.js";
import { runBatchExtraction } from "../lib/library/batch-runner.js";
import {
  trackExtractionJob,
  untrackExtractionJob,
  abortAllExtractionJobs,
} from "../lib/dataset-v2/coordinator-pipeline.js";
import { getModelProfile } from "../lib/dataset-v2/model-profile.js";
import {
  buildExtractorResponseFormat,
  buildJudgeResponseFormat,
} from "../lib/dataset-v2/json-schemas.js";
import { ALLOWED_DOMAINS } from "../crystallizer-constants.js";

interface StartExtractionArgs {
  bookSourcePath: string;
  /** Optional: индексы глав для обработки (по умолчанию — все). */
  chapterRange?: { from: number; to: number };
  /** Override модели для extractor/judge (по умолчанию — BIG profile). */
  extractModel?: string;
  judgeModel?: string;
  scoreThreshold?: number;
  /**
   * Имя Qdrant-коллекции, куда уходят принятые концепты + где
   * выполняется cross-library dedup. Если не указано — `ACCEPTED_COLLECTION`
   * (back-compat). UI Iter 5/6 будет передавать выбранную тематическую
   * коллекцию (marketing, ux, seo, ...).
   */
  targetCollection?: string;
}

interface StartExtractionResult {
  jobId: string;
  bookTitle: string;
  totalChapters: number;
  processedChapters: number;
  totalConcepts: { extractedRaw: number; afterDedup: number; accepted: number; rejected: number };
  warnings: string[];
}

const activeJobs = new Map<string, AbortController>();

/**
 * Iter 7: cancel-batch — Map<batchId, AbortController> поверх activeJobs.
 *
 * Без этого `dataset-v2:cancel` останавливал бы только текущую
 * runExtraction внутри батча, а цикл `for (let i…)` тут же шёл к
 * следующей книге. Теперь UI вызывает `dataset-v2:cancel-batch(batchId)`
 * → батч-цикл проверяет signal в начале каждой итерации и выходит
 * чисто, помечая оставшиеся как `aborted`.
 */
const activeBatches = new Map<string, AbortController>();

export function abortAllDatasetV2(reason: string): void {
  for (const [id, ctrl] of activeJobs.entries()) {
    ctrl.abort(reason);
    activeJobs.delete(id);
  }
  for (const [bid, ctrl] of activeBatches.entries()) {
    ctrl.abort(reason);
    activeBatches.delete(bid);
  }
  /* Also clear coordinator-side tracking so the watchdog/shutdown path
     doesn't try to pause a job whose AbortController is already gone. */
  abortAllExtractionJobs(reason);
}

/**
 * Crystallizer LLM wrapper.
 *
 * Three guarantees vs the previous direct `chat()` call:
 *   1. `chatWithPolicy` provides retry/backoff/adaptive timeout (closes
 *      AUDIT-2026-04 heresy #1 -- pipeline no longer dies on a single
 *      network blip).
 *   2. `signal` is captured by closure and forwarded as `externalSignal`
 *      so `dataset-v2:cancel` aborts the in-flight HTTP request, not just
 *      the gap between requests.
 *   3. Adaptive model profile (model-profile.ts) автоматически подбирает
 *      maxTokens budget, response_format и stop sequences по тегам модели
 *      из curated-models.json. Thinking-модели (qwen3.6) получают 16k+ токенов
 *      и stop=["</think>"]; tool-capable-coder получают JSON Schema decoding.
 *      Защищает от "0 концептов" из-за выгорания max_tokens на reasoning.
 *
 * Caller указывает `role`: "extractor" определяет JSON Schema = массив концептов,
 * "judge" — single JudgeResult. Профиль модели — общий по тегам.
 */
function makeLlm(
  modelKey: string,
  signal: AbortSignal,
  role: "extractor" | "judge",
): (args: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
}) => Promise<{ content: string; reasoningContent?: string }> {
  const profilePromise = getModelProfile(modelKey);
  const allowedDomains = Array.from(ALLOWED_DOMAINS).sort();
  const responseFormatBuilder =
    role === "extractor" ? () => buildExtractorResponseFormat(allowedDomains) : () => buildJudgeResponseFormat();

  return async ({ messages, temperature, maxTokens }) => {
    const profile = await profilePromise;
    /* Caller (extractor.ts / judge.ts) задаёт hint для maxTokens, но профиль
       модели имеет приоритет: thinking-моделям нужно МИНИМУМ profile.maxTokens,
       чтобы не выгореть на reasoning. Берём максимум из двух — caller может
       поднять выше профиля для длинных глав, но не опустить ниже. */
    const callerHint = maxTokens ?? 4096;
    const effectiveMaxTokens = Math.max(callerHint, profile.maxTokens);

    const response = await chatWithPolicy(
      {
        model: modelKey,
        messages,
        sampling: {
          temperature: temperature ?? 0.4,
          top_p: 0.9,
          top_k: 30,
          min_p: 0,
          presence_penalty: 0,
          max_tokens: effectiveMaxTokens,
        },
        stop: profile.stop,
        responseFormat: profile.useResponseFormat ? responseFormatBuilder() : undefined,
        chatTemplateKwargs: profile.chatTemplateKwargs,
      },
      { externalSignal: signal },
    );
    /* Прокидываем оба поля — extractor/judge ниже разберут через reasoning-decoder. */
    return { content: response.content, reasoningContent: response.reasoningContent };
  };
}

/**
 * Dual-Prompt Routing: thinking-heavy модели (Qwen3.6, DeepSeek-R1) ломаются от
 * unicode-операторов mechanicus-грамматики (⊕ → ↑ ↓ ≡ ⊗ ∅ ⊙) — их RL-тюнинг
 * требует естественного языка для reasoning. Им даём cognitive-промпт.
 * Всем остальным (non-thinking-instruct, tool-capable-coder, small-fast,
 * default-fallback) — компактный mechanicus-промпт со скрина (плотность
 * <8 токенов/правило, идеален для не-reasoning моделей).
 */
function pickPromptKey(profileSource: string): "mechanicus" | "cognitive" {
  return profileSource === "thinking-heavy" ? "cognitive" : "mechanicus";
}

/**
 * Core extraction routine. Используется и `dataset-v2:start-extraction`
 * (single book), и `dataset-v2:start-batch` (multi-book queue из Library).
 * Получает emit() от caller'а -- это позволяет batch wrapper'у добавлять
 * свой `batchId`/`bookIndex` к каждому событию.
 */
async function runExtraction(
  args: StartExtractionArgs,
  emit: (event: Record<string, unknown>) => void,
): Promise<StartExtractionResult> {
  if (!args || typeof args.bookSourcePath !== "string") throw new Error("bookSourcePath required");

  /* Резолвим целевую коллекцию ДО запуска парсера/моделей: если имя
     невалидно (опечатка с фронта), хотим получить понятную ошибку
     прежде чем потратить минуты на parseBook + extraction. */
  const targetCollection = args.targetCollection ?? ACCEPTED_COLLECTION;
  assertValidCollectionName(targetCollection);

  const jobId = randomUUID();
  const ctrl = new AbortController();
  activeJobs.set(jobId, ctrl);
  trackExtractionJob(jobId, ctrl);
  coordinator.reportBatchStart({
    pipeline: "extraction",
    batchId: jobId,
    startedAt: new Date().toISOString(),
    config: {
      bookSourcePath: args.bookSourcePath,
      extractModel: args.extractModel,
      judgeModel: args.judgeModel,
      chapterRange: args.chapterRange,
      targetCollection,
    },
  });

  const emitWithJob = (event: Record<string, unknown>): void => emit({ jobId, ...event });

  const extractModel = args.extractModel ?? PROFILE.BIG.key;
  const judgeModel = args.judgeModel ?? PROFILE.BIG.key;
  const llmExtract = makeLlm(extractModel, ctrl.signal, "extractor");
  const llmJudge = makeLlm(judgeModel, ctrl.signal, "judge");

  /* Routing промпта по тегам модели extractor'а. judge — отдельный single-object
     промпт, не зависит от mechanicus/cognitive split. */
  const extractProfile = await getModelProfile(extractModel);
  const promptKey = pickPromptKey(extractProfile.source);
  emitWithJob({
    stage: "config",
    phase: "info",
    extractModel,
    judgeModel,
    promptKey,
    profileSource: extractProfile.source,
    targetCollection,
  });

  const prefs = await getPreferencesStore().getAll();

  try {
    emitWithJob({ stage: "parse", phase: "start", bookSourcePath: args.bookSourcePath });
    /* AUDIT MED-4: parseBook вызывался без opts → отсканированные PDF
       проваливались в Crystallizer тихим "0 chapters", даже когда
       prefs.ocrEnabled=true. Также signal не пробрасывался → cancel
       не прерывал многомегабайтный PDF parse. */
    const parsed = await parseBook(args.bookSourcePath, {
      ocrEnabled: prefs.ocrEnabled && isOcrSupported(),
      ocrLanguages: prefs.ocrLanguages,
      ocrAccuracy: prefs.ocrAccuracy,
      ocrPdfDpi: prefs.ocrPdfDpi,
      djvuOcrProvider: prefs.djvuOcrProvider,
      djvuRenderDpi: prefs.djvuRenderDpi,
      openrouterApiKey: prefs.openrouterApiKey,
      signal: ctrl.signal,
    });
    const totalChapters = parsed.sections.length;
    const range = args.chapterRange ?? { from: 0, to: totalChapters };
    emitWithJob({ stage: "parse", phase: "done", bookTitle: parsed.metadata.title, totalChapters });

    const stats = { extractedRaw: 0, afterDedup: 0, accepted: 0, rejected: 0 };
    const warnings: string[] = [];
    let processed = 0;

    for (let ci = range.from; ci < Math.min(range.to, totalChapters); ci++) {
      if (ctrl.signal.aborted) throw new Error("job aborted");
      const section = parsed.sections[ci];

      /* Stage 1 — topological chunker (async: thematic drift uses embeddings) */
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
      emitWithJob({ stage: "chunker", chapterIndex: ci, chapterTitle: section.title, chunks: chunks.length });
      if (chunks.length === 0) continue;
      if (ctrl.signal.aborted) throw new Error("job aborted");

      /* Stage 2 — extractor */
      const extractRes = await extractChapterConcepts({
        chunks,
        promptsDir: null,
        promptKey,
        signal: ctrl.signal,
        callbacks: {
          llm: llmExtract,
          onEvent: (e: ExtractEvent) => emitWithJob({ stage: "extract", chapterIndex: ci, ...e }),
        },
      });
      stats.extractedRaw += extractRes.conceptsTotal.length;
      warnings.push(...extractRes.warnings);
      if (ctrl.signal.aborted) throw new Error("job aborted");

      /* Stage 3 — intra-dedup */
      const dedupRes = await dedupChapterConcepts({
        concepts: extractRes.conceptsTotal,
        bookSourcePath: args.bookSourcePath,
        bookTitle: parsed.metadata.title,
        chapterIndex: ci,
        chapterTitle: section.title,
        threshold: prefs.intraDedupThreshold,
        onEvent: (e: IntraDedupEvent) => emitWithJob({ stage: "intra-dedup", chapterIndex: ci, ...e }),
      });
      stats.afterDedup += dedupRes.concepts.length;
      if (ctrl.signal.aborted) throw new Error("job aborted");

      /* Stage 4 — judge + cross-library + accept */
      const judgeRes = await judgeAndAccept({
        concepts: dedupRes.concepts,
        promptsDir: null,
        scoreThreshold: args.scoreThreshold ?? prefs.judgeScoreThreshold,
        crossLibDupeThreshold: prefs.crossLibDupeThreshold,
        signal: ctrl.signal,
        targetCollection,
        callbacks: {
          llm: llmJudge,
          onEvent: (e: JudgeEvent) => emitWithJob({ stage: "judge", chapterIndex: ci, ...e }),
        },
      });
      stats.accepted += judgeRes.accepted.length;
      stats.rejected += judgeRes.rejected.length;
      processed++;

      emitWithJob({
        stage: "chapter",
        phase: "done",
        chapterIndex: ci,
        extracted: extractRes.conceptsTotal.length,
        deduped: dedupRes.concepts.length,
        accepted: judgeRes.accepted.length,
        rejected: judgeRes.rejected.length,
      });
    }

    emitWithJob({ stage: "job", phase: "done", stats });

    return {
      jobId,
      bookTitle: parsed.metadata.title,
      totalChapters,
      processedChapters: processed,
      totalConcepts: stats,
      warnings,
    };
  } finally {
    activeJobs.delete(jobId);
    untrackExtractionJob(jobId);
    coordinator.reportBatchEnd(jobId);
  }
}

export function registerDatasetV2Ipc(getMainWindow: () => BrowserWindow | null): void {
  const broadcast = (event: Record<string, unknown>): void => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("dataset-v2:event", event);
    }
  };

  ipcMain.handle(
    "dataset-v2:start-extraction",
    async (_e, args: StartExtractionArgs): Promise<StartExtractionResult> => {
      return runExtraction(args, broadcast);
    }
  );

  ipcMain.handle("dataset-v2:cancel", async (_e, jobId: string): Promise<boolean> => {
    const ctrl = activeJobs.get(jobId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeJobs.delete(jobId);
    untrackExtractionJob(jobId);
    coordinator.reportBatchEnd(jobId);
    return true;
  });

  /**
   * Batch crystallization для нескольких книг подряд из Library каталога.
   *
   * Guard: каждая книга должна быть `evaluated` И иметь `qualityScore >= minQuality`
   * И не быть `is_fiction_or_water=true` (если фильтр включён). Иначе книга
   * скипается с warning -- мы НЕ тратим LLM на мусор.
   *
   * Прогресс батча летит как `dataset-v2:event` с `bookIndex`/`bookTotal`/`bookId`,
   * а внутри каждой книги -- обычные события parse/extract/judge.
   *
   * Один batchId на серию книг; внутри -- последовательно создаются jobId
   * на каждую книгу и трекаются как обычный extraction.
   */
  ipcMain.handle(
    "dataset-v2:start-batch",
    async (
      _e,
      args: {
        bookIds: string[];
        minQuality?: number;
        skipFictionOrWater?: boolean;
        extractModel?: string;
        judgeModel?: string;
        scoreThreshold?: number;
        /** Тематическая Qdrant-коллекция для всех книг батча. */
        targetCollection?: string;
      }
    ): Promise<{
      batchId: string;
      total: number;
      processed: number;
      skipped: Array<{ bookId: string; reason: string }>;
      results: Array<{
        bookId: string;
        bookTitle: string;
        totalChapters: number;
        processedChapters: number;
        accepted: number;
        rejected: number;
      }>;
    }> => {
      if (!args || !Array.isArray(args.bookIds) || args.bookIds.length === 0) {
        throw new Error("bookIds required");
      }
      /* Резолвим коллекцию ОДИН раз для всего батча. Все книги пишут
         в одну тематическую коллекцию -- это и есть смысл батча. */
      const targetCollection = args.targetCollection ?? ACCEPTED_COLLECTION;
      assertValidCollectionName(targetCollection);

      const { getBookById, setBookStatus } = await import("../lib/library/cache-db.js");
      const batchId = randomUUID();

      /* Iter 7: один AbortController на весь батч. cancel-batch handler
         его abort()-ит, batch-runner выходит между книгами. */
      const batchCtrl = new AbortController();
      activeBatches.set(batchId, batchCtrl);

      try {
        const summary = await runBatchExtraction(
          { ...args, targetCollection, batchId },
          {
            getBookById,
            setBookStatus,
            cancelSignal: batchCtrl.signal,
            emit: (event) => broadcast({ batchId, ...event }),
            runExtraction: async (extractionArgs, ctx) => {
              /* Per-book emitter подмешивает bookIndex/bookId через
                 broadcast: каждое внутреннее extract/chunker/judge
                 событие летит с правильным bookId, не теряется. */
              const perBookEmit = (event: Record<string, unknown>): void =>
                broadcast({
                  batchId,
                  bookIndex: ctx.bookIndex,
                  bookTotal: ctx.bookTotal,
                  bookId: ctx.bookId,
                  ...event,
                });
              return runExtraction(extractionArgs, perBookEmit);
            },
          },
        );
        return summary;
      } finally {
        activeBatches.delete(batchId);
      }
    }
  );

  /**
   * Iter 7: cancel-batch — прерывает батч-цикл целиком.
   *
   * Контракт:
   *   1. Ставит abort на batchCtrl → цикл for(let i…) выходит ПЕРЕД
   *      следующей итерацией.
   *   2. Если в этот момент уже работает runExtraction (текущая книга),
   *      она доработает до конца (renderer вызывает `dataset-v2:cancel`
   *      на её jobId сам, если хочет убить и её тоже).
   *   3. Возвращает `true` если батч был активен, `false` если уже завершён.
   */
  ipcMain.handle("dataset-v2:cancel-batch", async (_e, batchId: string): Promise<boolean> => {
    const ctrl = activeBatches.get(batchId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel-batch");
    activeBatches.delete(batchId);
    return true;
  });

  /**
   * Сколько концептов в выбранной коллекции (для UI бейджа).
   *
   * Принимает `collection?: string` -- если не указано, читает
   * `ACCEPTED_COLLECTION` (legacy default). UI Iter 5 будет передавать
   * выбранную тематическую коллекцию: бейдж покажет счётчик именно
   * для текущего датасета, а не общий микс по всем темам.
   */
  ipcMain.handle(
    "dataset-v2:list-accepted",
    async (_e, collection?: string): Promise<{ total: number; byDomain: Record<string, number>; collection: string }> => {
      const { fetchQdrantJson, QDRANT_URL } = await import("../lib/qdrant/http-client.js");
      const targetCollection = collection ?? ACCEPTED_COLLECTION;
      try {
        assertValidCollectionName(targetCollection);
      } catch (e) {
        console.warn(`[dataset-v2:list-accepted] ${e instanceof Error ? e.message : e}`);
        return { total: 0, byDomain: {}, collection: targetCollection };
      }
      try {
        const data = await fetchQdrantJson<{ result: { points_count?: number } }>(
          `${QDRANT_URL}/collections/${targetCollection}`
        );
        const total = data.result.points_count ?? 0;
        const byDomain: Record<string, number> = {};

        /* S2.5: при коллекции > 50k концептов scroll-fetch отключён ради OOM,
           но раньше это происходило молча — UI просто видел пустой byDomain
           без объяснения. Теперь пишем diag-warning, чтобы dev/power-user
           видел в DevTools, что breakdown подавлен из-за объёма. */
        if (total > 50_000) {
          console.warn(
            `[dataset-v2:list-accepted] domain breakdown skipped: ${targetCollection} has ${total} points (> 50000 cap)`
          );
        }
        if (total > 0 && total <= 50_000) {
          /* AUDIT MED-3: scroll fetch шёл голым `fetch()` без timeout — при
             зависшем Qdrant IPC-handler висел навсегда, блокируя UI-бейдж.
             fetchQdrantJson даёт QDRANT_TIMEOUT_MS + унифицированные headers.
             Большой scroll (10k точек) — поднимаем timeout до 30s. */
          const scrollData = await fetchQdrantJson<{
            result: { points: Array<{ payload?: { domain?: string } }> };
          }>(
            `${QDRANT_URL}/collections/${targetCollection}/points/scroll`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                limit: Math.min(total, 10_000),
                with_payload: ["domain"],
                with_vector: false,
              }),
              timeoutMs: 30_000,
            },
          );
          for (const pt of scrollData.result.points) {
            const d = pt.payload?.domain || "unknown";
            byDomain[d] = (byDomain[d] || 0) + 1;
          }
        }

        return { total, byDomain, collection: targetCollection };
      } catch (e) {
        /* AUDIT P0 (Inquisitor): раньше любая ошибка Qdrant (сеть, 401,
           таймаут, отсутствие коллекции) превращалась в "0 концептов" —
           UI показывал пустой бейдж и пользователь не понимал, что
           сервер недоступен. Логируем, но contract не меняем чтобы
           не ломать renderer. */
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[dataset-v2:list-accepted] Qdrant unavailable for ${targetCollection}: ${msg}`);
        return { total: 0, byDomain: {}, collection: targetCollection };
      }
    }
  );

  /**
   * Удалить концепт из выбранной коллекции (manual rejection пользователем).
   *
   * Принимает `(conceptId, collection?)` -- collection обязан совпадать
   * с той, куда concept был upsert'нут. UI должен передавать ту же
   * коллекцию, что использует listAccepted (иначе delete вернёт false).
   */
  ipcMain.handle(
    "dataset-v2:reject-accepted",
    async (_e, conceptId: string, collection?: string): Promise<boolean> => {
      if (typeof conceptId !== "string" || conceptId.length === 0) return false;
      const targetCollection = collection ?? ACCEPTED_COLLECTION;
      try {
        assertValidCollectionName(targetCollection);
      } catch (e) {
        console.warn(`[dataset-v2:reject-accepted] ${e instanceof Error ? e.message : e}`);
        return false;
      }
      const { QDRANT_URL, QDRANT_API_KEY } = await import("../lib/qdrant/http-client.js");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
      const resp = await fetch(`${QDRANT_URL}/collections/${targetCollection}/points/delete?wait=true`, {
        method: "POST",
        headers,
        body: JSON.stringify({ points: [conceptId] }),
      });
      return resp.ok;
    }
  );

  /**
   * dataset-v2:synthesize -- Iter 9: запускает scripts/dataset-synth.ts
   * как child-process. Возвращает {pid, outputPath, command} сразу;
   * progress пишется в файл-лог рядом с output. UI открывает файл-папку
   * по завершении. Не блокирует main thread.
   *
   * Контракт: вместо прямого вызова синтеза в main process (где LM Studio
   * вызовы блокировали бы IPC очередь), мы spawn-им tsx в отдельном
   * Node.js процессе. Это единственный безопасный способ запускать
   * 60+ минутный LLM-marathon из UI без подвисания app shell.
   */
  ipcMain.handle(
    "dataset-v2:synthesize",
    async (
      _e,
      args: {
        collection: string;
        outputPath: string;
        pairsPerConcept?: number;
        includeReasoning?: boolean;
        preset?: string;
        model?: string;
        limit?: number;
      },
    ): Promise<{ ok: boolean; pid?: number; logPath?: string; error?: string }> => {
      const { spawn } = await import("child_process");
      const { promises: fsAsync, createWriteStream: createLog } = await import("fs");
      const path = await import("path");

      try {
        assertValidCollectionName(args.collection);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      const out = path.resolve(args.outputPath);
      const logPath = out.replace(/\.jsonl$/i, "") + ".log";

      try {
        await fsAsync.mkdir(path.dirname(out), { recursive: true });
      } catch (e) {
        return { ok: false, error: `mkdir: ${e instanceof Error ? e.message : String(e)}` };
      }

      const cliArgs = [
        "scripts/dataset-synth.ts",
        "--collection", args.collection,
        "--out", out,
        "--pairs-per-concept", String(args.pairsPerConcept ?? 2),
        "--preset", args.preset ?? "auto",
      ];
      if (args.includeReasoning) cliArgs.push("--include-reasoning");
      if (args.model)            cliArgs.push("--model", args.model);
      if (args.limit)            cliArgs.push("--limit", String(args.limit));

      /* npm-script "dataset:synth" под капотом — `tsx`. Используем npx
         напрямую чтобы избежать оверхеда npm wrapper'а. shell:true нужен
         для Windows .cmd shim'ов. */
      const child = spawn("npx", ["tsx", ...cliArgs], {
        cwd: process.cwd(),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      const logStream = createLog(logPath, { flags: "w", encoding: "utf8" });
      logStream.write(`[synth] cmd: npx tsx ${cliArgs.join(" ")}\n[synth] cwd: ${process.cwd()}\n\n`);
      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);

      child.on("error", (err) => {
        try { logStream.write(`\n[synth] spawn error: ${err.message}\n`); } catch { /* stream may be closed */ }
      });
      child.on("close", (code) => {
        try { logStream.write(`\n[synth] exit code: ${code}\n`); logStream.end(); } catch { /* ignore */ }
      });

      return { ok: true, pid: child.pid, logPath };
    },
  );
}
