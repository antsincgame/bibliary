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
  extractDeltaKnowledge,
  assertValidCollectionName,
  isNonContentSection,
  type DeltaExtractEvent,
  type DeltaKnowledge,
} from "../lib/dataset-v2/index.js";
import { extractChapterThesis } from "../lib/dataset-v2/delta-extractor.js";
import { embedPassage } from "../lib/embedder/shared.js";
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
import { buildDeltaKnowledgeResponseFormat } from "../lib/dataset-v2/json-schemas.js";
import { ALLOWED_DOMAINS } from "../crystallizer-constants.js";

const DEFAULT_COLLECTION = "delta-knowledge";

interface StartExtractionArgs {
  bookSourcePath: string;
  /** Optional: индексы глав для обработки (по умолчанию — все). */
  chapterRange?: { from: number; to: number };
  /** Override модели (по умолчанию — BIG profile). */
  extractModel?: string;
  /**
   * Имя Qdrant-коллекции, куда уходят принятые концепты + где
   * выполняется cross-library dedup. Если не указано — `DEFAULT_COLLECTION`
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
  totalDelta: { chunks: number; accepted: number; skipped: number };
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

/** Track spawned synth child processes so we can kill them on app quit. */
const activeSynthChildren = new Set<import("child_process").ChildProcess>();

export function killAllSynthChildren(): void {
  for (const child of activeSynthChildren) {
    try { child.kill(); } catch { /* already dead */ }
  }
  activeSynthChildren.clear();
}

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

  return async ({ messages, temperature, maxTokens }) => {
    const profile = await profilePromise;
    const callerHint = maxTokens ?? 4096;
    const effectiveMaxTokens = Math.max(callerHint, profile.maxTokens);

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
  };
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
  const extractModel = args.extractModel ?? PROFILE.BIG.key;
  const llm = makeLlm(extractModel, ctrl.signal);

  emitWithJob({ stage: "config", phase: "info", extractModel, targetCollection });

  const prefs = await getPreferencesStore().getAll();

  try {
    emitWithJob({ stage: "parse", phase: "start", bookSourcePath: args.bookSourcePath });
    console.log(`\n[extraction] ═══ START ═══ collection="${targetCollection}" model="${extractModel}"`);
    console.log(`[extraction] parsing: ${args.bookSourcePath}`);
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
    console.log(`[extraction] parsed "${parsed.metadata.title}" — ${totalChapters} chapters, range ${range.from}..${range.to}`);
    emitWithJob({ stage: "parse", phase: "done", bookTitle: parsed.metadata.title, totalChapters });

    const stats = { chunks: 0, accepted: 0, skipped: 0 };
    const warnings: string[] = [];
    let processed = 0;

    const { fetchQdrantJson, QDRANT_URL } = await import("../lib/qdrant/http-client.js");
    const { EMBEDDING_DIM } = await import("../lib/scanner/embedding.js");
    console.log(`[extraction] Qdrant: ${QDRANT_URL} → collection "${targetCollection}" (dim=${EMBEDDING_DIM})`);
    await fetchQdrantJson(`${QDRANT_URL}/collections/${targetCollection}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: EMBEDDING_DIM, distance: "Cosine" },
      }),
    }).catch((e) => {
      console.log(`[extraction] collection PUT skipped (may exist): ${e instanceof Error ? e.message : e}`);
    });

    for (let ci = range.from; ci < Math.min(range.to, totalChapters); ci++) {
      if (ctrl.signal.aborted) throw new Error("job aborted");
      const section = parsed.sections[ci];
      if (isNonContentSection(section)) {
        console.log(`[extraction] ch${ci} "${section.title}" skipped as non-content section`);
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
      const deltaRes = await extractDeltaKnowledge({
        chunks,
        chapterThesis: thesis,
        promptsDir: null,
        signal: ctrl.signal,
        callbacks: {
          llm,
          onEvent: (e: DeltaExtractEvent) => emitWithJob({ stage: "delta", chapterIndex: ci, ...e }),
        },
      });
      warnings.push(...deltaRes.warnings);

      /* Step 4 — upsert accepted deltas to Qdrant */
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
                bookSourcePath: delta.bookSourcePath,
                acceptedAt: delta.acceptedAt,
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
        skipped: number;
      }>;
    }> => {
      if (!args || !Array.isArray(args.bookIds) || args.bookIds.length === 0) {
        throw new Error("bookIds required");
      }
      /* Резолвим коллекцию ОДИН раз для всего батча. Все книги пишут
         в одну тематическую коллекцию -- это и есть смысл батча. */
      const targetCollection = args.targetCollection ?? DEFAULT_COLLECTION;
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
   * `DEFAULT_COLLECTION` (legacy default). UI Iter 5 будет передавать
   * выбранную тематическую коллекцию: бейдж покажет счётчик именно
   * для текущего датасета, а не общий микс по всем темам.
   */
  ipcMain.handle(
    "dataset-v2:list-accepted",
    async (_e, collection?: string): Promise<{ total: number; byDomain: Record<string, number>; collection: string }> => {
      const { fetchQdrantJson, QDRANT_URL } = await import("../lib/qdrant/http-client.js");
      const targetCollection = collection ?? DEFAULT_COLLECTION;
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
      const targetCollection = collection ?? DEFAULT_COLLECTION;
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

      activeSynthChildren.add(child);

      const logStream = createLog(logPath, { flags: "w", encoding: "utf8" });
      logStream.write(`[synth] cmd: npx tsx ${cliArgs.join(" ")}\n[synth] cwd: ${process.cwd()}\n\n`);
      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);

      child.on("error", (err) => {
        try { logStream.write(`\n[synth] spawn error: ${err.message}\n`); } catch { /* stream may be closed */ }
      });
      child.on("close", (code) => {
        activeSynthChildren.delete(child);
        try { logStream.write(`\n[synth] exit code: ${code}\n`); logStream.end(); } catch { /* ignore */ }
      });

      return { ok: true, pid: child.pid, logPath };
    },
  );
}
