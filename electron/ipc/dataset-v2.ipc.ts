/**
 * Phase 3.1 — Dataset v2 IPC.
 *
 * Один публичный метод `dataset-v2:start-extraction` запускает Stages 1-4 на
 * одной книге (или диапазоне глав). Прогресс летит push-events `dataset-v2:event`
 * в renderer для alchemy log.
 *
 * Stage 5 (triplet generator) подключается в следующей итерации — пока
 * accepted-concepts писались в коллекцию `dataset-accepted-concepts` Qdrant,
 * откуда их забирает существующий dataset-generator (как обычные SourceChunks).
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
  type ExtractEvent,
  type IntraDedupEvent,
  type JudgeEvent,
  type AcceptedConcept,
} from "../lib/dataset-v2/index.js";
import { chatWithPolicy, PROFILE } from "../lmstudio-client.js";
import { getPreferencesStore } from "../lib/preferences/store.js";
import { coordinator } from "../lib/resilience/batch-coordinator.js";
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
import { ALLOWED_DOMAINS } from "../mechanicus-prompt.js";

interface StartExtractionArgs {
  bookSourcePath: string;
  /** Optional: индексы глав для обработки (по умолчанию — все). */
  chapterRange?: { from: number; to: number };
  /** Override модели для extractor/judge (по умолчанию — BIG profile). */
  extractModel?: string;
  judgeModel?: string;
  scoreThreshold?: number;
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

export function abortAllDatasetV2(reason: string): void {
  for (const [id, ctrl] of activeJobs.entries()) {
    ctrl.abort(reason);
    activeJobs.delete(id);
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

export function registerDatasetV2Ipc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    "dataset-v2:start-extraction",
    async (_e, args: StartExtractionArgs): Promise<StartExtractionResult> => {
      if (!args || typeof args.bookSourcePath !== "string") throw new Error("bookSourcePath required");

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
        },
      });

      const win = getMainWindow();
      const emit = (event: Record<string, unknown>): void => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("dataset-v2:event", { jobId, ...event });
        }
      };

      const extractModel = args.extractModel ?? PROFILE.BIG.key;
      const judgeModel = args.judgeModel ?? PROFILE.BIG.key;
      const llmExtract = makeLlm(extractModel, ctrl.signal, "extractor");
      const llmJudge = makeLlm(judgeModel, ctrl.signal, "judge");

      /* Routing промпта по тегам модели extractor'а. judge — отдельный single-object
         промпт, не зависит от mechanicus/cognitive split. */
      const extractProfile = await getModelProfile(extractModel);
      const promptKey = pickPromptKey(extractProfile.source);
      emit({ stage: "config", phase: "info", extractModel, judgeModel, promptKey, profileSource: extractProfile.source });

      const prefs = await getPreferencesStore().getAll();

      try {
        emit({ stage: "parse", phase: "start", bookSourcePath: args.bookSourcePath });
        /* AUDIT MED-4: parseBook вызывался без opts → отсканированные PDF
           проваливались в Crystallizer тихим "0 chapters", даже когда
           prefs.ocrEnabled=true. Также signal не пробрасывался → cancel
           не прерывал многомегабайтный PDF parse. */
        const parsed = await parseBook(args.bookSourcePath, {
          ocrEnabled: prefs.ocrEnabled && isOcrSupported(),
          ocrLanguages: prefs.ocrLanguages,
          ocrAccuracy: prefs.ocrAccuracy,
          ocrPdfDpi: prefs.ocrPdfDpi,
          signal: ctrl.signal,
        });
        const totalChapters = parsed.sections.length;
        const range = args.chapterRange ?? { from: 0, to: totalChapters };
        emit({ stage: "parse", phase: "done", bookTitle: parsed.metadata.title, totalChapters });

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
          emit({ stage: "chunker", chapterIndex: ci, chapterTitle: section.title, chunks: chunks.length });
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
              onEvent: (e: ExtractEvent) => emit({ stage: "extract", chapterIndex: ci, ...e }),
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
            onEvent: (e: IntraDedupEvent) => emit({ stage: "intra-dedup", chapterIndex: ci, ...e }),
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
            callbacks: {
              llm: llmJudge,
              onEvent: (e: JudgeEvent) => emit({ stage: "judge", chapterIndex: ci, ...e }),
            },
          });
          stats.accepted += judgeRes.accepted.length;
          stats.rejected += judgeRes.rejected.length;
          processed++;

          emit({
            stage: "chapter",
            phase: "done",
            chapterIndex: ci,
            extracted: extractRes.conceptsTotal.length,
            deduped: dedupRes.concepts.length,
            accepted: judgeRes.accepted.length,
            rejected: judgeRes.rejected.length,
          });
        }

        emit({ stage: "job", phase: "done", stats });

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

  /** Сколько концептов лежит в dataset-accepted-concepts (для UI бейджа). */
  ipcMain.handle("dataset-v2:list-accepted", async (): Promise<{ total: number; byDomain: Record<string, number> }> => {
    const { fetchQdrantJson, QDRANT_URL } = await import("../lib/qdrant/http-client.js");
    const { ACCEPTED_COLLECTION } = await import("../lib/dataset-v2/judge.js");
    try {
      const data = await fetchQdrantJson<{ result: { points_count?: number } }>(
        `${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}`
      );
      const total = data.result.points_count ?? 0;
      const byDomain: Record<string, number> = {};

      if (total > 0 && total <= 50_000) {
        /* AUDIT MED-3: scroll fetch шёл голым `fetch()` без timeout — при
           зависшем Qdrant IPC-handler висел навсегда, блокируя UI-бейдж.
           fetchQdrantJson даёт QDRANT_TIMEOUT_MS + унифицированные headers.
           Большой scroll (10k точек) — поднимаем timeout до 30s. */
        const scrollData = await fetchQdrantJson<{
          result: { points: Array<{ payload?: { domain?: string } }> };
        }>(
          `${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}/points/scroll`,
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

      return { total, byDomain };
    } catch {
      return { total: 0, byDomain: {} };
    }
  });

  /** Удалить концепт из принятых (manual rejection пользователем). */
  ipcMain.handle("dataset-v2:reject-accepted", async (_e, conceptId: string): Promise<boolean> => {
    if (typeof conceptId !== "string") return false;
    const { QDRANT_URL, QDRANT_API_KEY } = await import("../lib/qdrant/http-client.js");
    const { ACCEPTED_COLLECTION } = await import("../lib/dataset-v2/judge.js");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
    const resp = await fetch(`${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}/points/delete?wait=true`, {
      method: "POST",
      headers,
      body: JSON.stringify({ points: [conceptId] }),
    });
    return resp.ok;
  });

  /** Не используется напрямую, но экспортируется для shutdown в main.ts */
  void ((): AcceptedConcept | null => null)();
}
