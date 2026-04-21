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
 * Two guarantees vs the previous direct `chat()` call:
 *   1. `chatWithPolicy` provides retry/backoff/adaptive timeout (closes
 *      AUDIT-2026-04 heresy #1 -- pipeline no longer dies on a single
 *      network blip).
 *   2. `signal` is captured by closure and forwarded as `externalSignal`
 *      so `dataset-v2:cancel` aborts the in-flight HTTP request, not just
 *      the gap between requests.
 */
function makeLlm(modelKey: string, signal: AbortSignal): (args: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string> {
  return async ({ messages, temperature, maxTokens }) => {
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
          max_tokens: maxTokens ?? 4096,
        },
      },
      { externalSignal: signal },
    );
    return response.content;
  };
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
      const llmExtract = makeLlm(extractModel, ctrl.signal);
      const llmJudge = makeLlm(judgeModel, ctrl.signal);

      const prefs = await getPreferencesStore().getAll();

      try {
        emit({ stage: "parse", phase: "start", bookSourcePath: args.bookSourcePath });
        const parsed = await parseBook(args.bookSourcePath);
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
    const { fetchQdrantJson, QDRANT_URL, QDRANT_API_KEY } = await import("../lib/qdrant/http-client.js");
    const { ACCEPTED_COLLECTION } = await import("../lib/dataset-v2/judge.js");
    try {
      const data = await fetchQdrantJson<{ result: { points_count?: number } }>(
        `${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}`
      );
      const total = data.result.points_count ?? 0;
      const byDomain: Record<string, number> = {};

      if (total > 0 && total <= 50_000) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
        const scrollResp = await fetch(
          `${QDRANT_URL}/collections/${ACCEPTED_COLLECTION}/points/scroll`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              limit: Math.min(total, 10_000),
              with_payload: ["domain"],
              with_vector: false,
            }),
          }
        );
        if (scrollResp.ok) {
          const scrollData = (await scrollResp.json()) as {
            result: { points: Array<{ payload?: { domain?: string } }> };
          };
          for (const pt of scrollData.result.points) {
            const d = pt.payload?.domain || "unknown";
            byDomain[d] = (byDomain[d] || 0) + 1;
          }
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
