import {
  chat,
  switchProfile,
  type ChatMessage,
  PROFILE,
} from "./lmstudio-client";
import {
  readProgress,
  readSourceChunks,
  readGoldExamples,
  startBatch,
  appendChunkLines,
  finalizeBatch,
  nextBatchName,
  registerDatasetAbort,
  unregisterDatasetAbort,
  type SourceChunk,
  type GoldExample,
  type Progress,
  type DatasetBatchState,
} from "./finetune-state";
import {
  PHASES,
  type ChunkPhase,
  type BatchSettings,
} from "./dataset-generator-config";

// Изолированная legacy v1 кодировка для генерации обучающих JSONL-строк finetune-датасета.
// Не использовать в новом коде — v2 (Crystallizer) применяет дуальную грамматику
// concept-extractor-mechanicus.md / concept-extractor-cognitive.md.
const LEGACY_V1_SYSTEM_PROMPT = `You are a MECHANICUS knowledge encoder. You convert editorial wisdom from books about UX, copywriting, SEO, UI, mobile design, performance, architecture and the web into compressed MECHANICUS-format chunks for a vector database.

SCHEMA (strict JSON, single object):
- principle: action-oriented transformation rule, 3-300 chars. NEVER a definition.
- explanation: MECHANICUS code, 10-2000 chars. Format: X.<domain>|rule_label: instruction; NO:antipattern; eg: "before" >> "after"
- domain: one of "copy" | "seo" | "ux" | "ui" | "mobile" | "perf" | "arch" | "web" | "research"
- tags: array of 1-10 kebab-case strings, specific to subtopic

OPERATORS:
-> sequence / leads to
== equivalence
!= not equal
+ combine
- removes
>> transformation (LEFT=bad, RIGHT=good)
NO: antipattern
eg: concrete example with before >> after

QUALITY RULE: The principle must let a practitioner TRANSFORM their work immediately. Definitions fail the /om test. Transformations pass.

OUTPUT: a single valid JSON object. No prose, no markdown fences, no commentary.`;
import {
  coordinator,
  withPolicy,
  DEFAULT_POLICY,
  buildRequestPolicy,
  isAbortError,
  telemetry,
} from "./lib/resilience";
import { getPreferencesStore } from "./lib/preferences/store";
import { getPromptStore, type DatasetRoleSpec, type DatasetRoles } from "./lib/prompts/store";
import { fitOrTrim, ContextOverflowError } from "./lib/token/overflow-guard";
import { ChunkTooLargeError } from "./lib/token/budget";

const MODEL_SWITCH_TIMEOUT_MS = 180_000;
const EXPECTED_TOKENS_PER_PHASE = 400;
const ASSUMED_INITIAL_TPS = 8;

/**
 * Build a RequestPolicy reflecting the user's current preferences.
 * Falls back to DEFAULT_POLICY if the store is unreachable (very early in
 * boot or in unit tests).
 */
async function getRuntimePolicy() {
  try {
    const prefs = await getPreferencesStore().getAll();
    return buildRequestPolicy({
      policyMaxRetries: prefs.policyMaxRetries,
      policyBaseBackoffMs: prefs.policyBaseBackoffMs,
      hardTimeoutCapMs: prefs.hardTimeoutCapMs,
    });
  } catch {
    return DEFAULT_POLICY;
  }
}

export type { ChunkPhase, BatchSettings } from "./dataset-generator-config";

export interface ChunkProgressEvent {
  batchId: string;
  index: number;
  total: number;
  chunkId: string;
  domain: string;
  principleHead: string;
  phase: ChunkPhase | "done" | "error";
  preview?: string;
  error?: string;
  elapsedMs?: number;
}

export interface BatchResult {
  batchId: string;
  batchName: string;
  batchFile: string;
  examplesCount: number;
  processedCount: number;
  failedCount: number;
  progress: Progress;
}

export type ProgressEmitter = (event: ChunkProgressEvent) => void;

export interface BatchRunOptions {
  resume?: boolean;
  resumeBatchName?: string;
  resumeBatchFile?: string;
}

interface RuntimeContext {
  batchId: string;
  signal: AbortSignal;
  emitter: ProgressEmitter;
  settings: BatchSettings;
  roles: DatasetRoles;
}

function pickFewShot(
  goldExamples: GoldExample[],
  domain: string,
  type: ChunkPhase,
  limit: number
): GoldExample[] {
  if (limit <= 0) return [];
  const matching = goldExamples.filter((ex) => ex.meta.type === type && ex.meta.domain === domain);
  if (matching.length >= limit) return matching.slice(0, limit);
  const seen = new Set(matching.map((ex) => ex.meta.source_chunk_id));
  const fallback = goldExamples.filter(
    (ex) => ex.meta.type === type && !seen.has(ex.meta.source_chunk_id)
  );
  const need = limit - matching.length;
  return [...matching, ...fallback.slice(0, need)];
}

function fewShotBlock(examples: GoldExample[], type: ChunkPhase): string {
  if (examples.length === 0) return "";
  const blocks = examples.map((ex, i) => {
    const human = ex.conversations.find((c) => c.from === "human")?.value ?? "";
    const gpt = ex.conversations.find((c) => c.from === "gpt")?.value ?? "";
    return `EXAMPLE ${i + 1}:
Input (${type}): ${human.slice(0, 300)}${human.length > 300 ? "…" : ""}
Output chunk: ${gpt.slice(0, 200)}…`;
  });
  return `FEW-SHOT EXAMPLES:\n${blocks.join("\n\n")}`;
}

function buildPrompt(
  spec: DatasetRoleSpec,
  chunk: SourceChunk,
  type: ChunkPhase,
  fewShot: string
): string {
  const antiList = spec.anti_examples
    .slice(0, 3)
    .map((a) => `- ${a}`)
    .join("\n");
  const chunkJson = JSON.stringify(
    { principle: chunk.principle, explanation: chunk.explanation, domain: chunk.domain, tags: chunk.tags },
    null,
    2
  );
  return `TASK: Generate a ${type} input for a MECHANICUS training pair.

VOICE: ${spec.voice}
FORMAT: ${spec.format}

GOOD EXAMPLE OF ${type}:
${spec.exemplar}

DO NOT WRITE LIKE THIS (these are wrong):
${antiList}

TARGET MECHANICUS CHUNK:
${chunkJson}

${fewShot}

Now generate ONLY the ${type} text. No labels. No JSON. No commentary. No markdown fences.`;
}

function buildExampleLine(type: ChunkPhase, humanInput: string, chunk: SourceChunk): string {
  const chunkJson = JSON.stringify({
    principle: chunk.principle,
    explanation: chunk.explanation,
    domain: chunk.domain,
    tags: chunk.tags,
  });

  return JSON.stringify({
    conversations: [
      { from: "system", value: LEGACY_V1_SYSTEM_PROMPT },
      { from: "human", value: humanInput },
      { from: "gpt", value: chunkJson },
    ],
    meta: {
      type,
      domain: chunk.domain,
      source_chunk_id: chunk.id,
      principle_head: chunk.principle.slice(0, 60),
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runPhase(
  ctx: RuntimeContext,
  modelKey: string,
  chunk: SourceChunk,
  goldExamples: GoldExample[],
  type: ChunkPhase,
  index: number,
  total: number
): Promise<string> {
  ctx.emitter({
    batchId: ctx.batchId,
    index: index + 1,
    total,
    chunkId: chunk.id,
    domain: chunk.domain,
    principleHead: chunk.principle.slice(0, 80),
    phase: type,
  });

  const spec = ctx.roles[type];
  const fewShotPicked = pickFewShot(goldExamples, chunk.domain, type, ctx.settings.fewShotCount);
  const fewShot = fewShotBlock(fewShotPicked, type);
  const userPrompt = buildPrompt(spec, chunk, type, fewShot);
  const messages: ChatMessage[] = [
    { role: "system", content: spec.system },
    { role: "user", content: userPrompt },
  ];

  const samplingOverride = ctx.settings.samplingOverrides?.[type];
  const sampling = { ...ctx.settings.sampling, ...spec.sampling, ...(samplingOverride ?? {}) };
  const maxCompletion = sampling.max_tokens ?? EXPECTED_TOKENS_PER_PHASE;

  // Token Budget guard: если контекст модели зарегистрирован — пробуем вместить,
  // иначе trim few-shot. ChunkTooLargeError → пометка failed, без падения batch.
  let safeMessages: ChatMessage[];
  try {
    safeMessages = (await fitOrTrim(modelKey, messages, maxCompletion)) as ChatMessage[];
  } catch (err) {
    if (err instanceof ContextOverflowError || err instanceof ChunkTooLargeError) {
      throw err;
    }
    safeMessages = messages;
  }

  const policy = await getRuntimePolicy();
  const text = await withPolicy(
    policy,
    ctx.signal,
    { expectedTokens: maxCompletion, observedTps: ASSUMED_INITIAL_TPS },
    async (innerSignal) => {
      const response = await chat({ model: modelKey, messages: safeMessages, sampling, signal: innerSignal });
      return response.content.trim();
    }
  );

  ctx.emitter({
    batchId: ctx.batchId,
    index: index + 1,
    total,
    chunkId: chunk.id,
    domain: chunk.domain,
    principleHead: chunk.principle.slice(0, 80),
    phase: type,
    preview: text.slice(0, 200),
  });

  return text;
}

export async function generateBatch(
  /**
   * Идентификатор запуска. Из IPC передаётся batchName (например, "batch-001"),
   * из CLI — произвольная метка ("cli-{timestamp}"). Используется только для
   * логирования; **внутри** generateBatch события прогресса и coordinator всегда
   * получают единый batchName, чтобы UI cancel/resume работали без mismatch.
   */
  _runId: string,
  signal: AbortSignal,
  settings: BatchSettings,
  emitter: ProgressEmitter,
  options: BatchRunOptions = {}
): Promise<BatchResult> {
  const profile = PROFILE[settings.profile];
  const [allChunks, progress, goldExamples, roles] = await Promise.all([
    readSourceChunks(),
    readProgress(),
    readGoldExamples(),
    getPromptStore().readDatasetRoles(),
  ]);

  const processedSet = new Set(progress.processed_chunk_ids);
  const unprocessed = allChunks.filter((c) => !processedSet.has(c.id));

  let batchName: string;
  let batchFile: string;
  let resumed = false;
  let preState: DatasetBatchState | null = null;

  if (options.resume && options.resumeBatchName && options.resumeBatchFile) {
    batchName = options.resumeBatchName;
    batchFile = options.resumeBatchFile;
    resumed = true;
  } else {
    const next = nextBatchName(progress);
    batchName = next.name;
    batchFile = next.file;
  }

  preState = await startBatch(batchName, batchFile, settings, resumed);
  const alreadyProcessed = new Set(preState.processedChunkIds);
  const queue = unprocessed.filter((c) => !alreadyProcessed.has(c.id)).slice(0, settings.batchSize);

  if (queue.length === 0 && preState.processedChunkIds.length === 0) {
    throw new Error("All chunks have been processed.");
  }

  await withTimeout(
    switchProfile(settings.profile, settings.contextLength),
    MODEL_SWITCH_TIMEOUT_MS,
    `LM Studio model switch exceeded ${MODEL_SWITCH_TIMEOUT_MS / 1000}s`
  );

  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort((signal as AbortSignal & { reason?: unknown }).reason ?? "parent-aborted");
  signal.addEventListener("abort", onParentAbort, { once: true });
  registerDatasetAbort(batchName, controller);

  coordinator.reportBatchStart({
    batchId: batchName,
    pipeline: "dataset",
    startedAt: preState.startedAt,
    config: settings,
  });

  // ВАЖНО: batchId в событиях прогресса == batchName, чтобы UI и coordinator
  // оперировали одним идентификатором. Параметр _runId — только для логов CLI.
  const ctx: RuntimeContext = { batchId: batchName, signal: controller.signal, emitter, settings, roles };

  let processedThisRun = 0;
  let failedCount = 0;
  let lastProcessedCount = preState.processedChunkIds.length;

  try {
    for (let i = 0; i < queue.length; i++) {
      if (controller.signal.aborted) break;
      const chunk = queue[i];
      const principleHead = chunk.principle.slice(0, 80);
      const startedAt = Date.now();

      try {
        const phaseLines: string[] = [];
        for (const phase of PHASES) {
          const text = await runPhase(ctx, profile.key, chunk, goldExamples, phase, i, queue.length);
          phaseLines.push(buildExampleLine(phase, text, chunk));
        }
        const append = await appendChunkLines(batchName, batchFile, phaseLines, chunk.id);
        lastProcessedCount = append.state.processedChunkIds.length;
        processedThisRun++;

        telemetry.logEvent({
          type: "batch.chunk.ok",
          batchId: batchName,
          chunkId: chunk.id,
          latencyMs: Date.now() - startedAt,
        });

        emitter({
          batchId: batchName,
          index: i + 1,
          total: queue.length,
          chunkId: chunk.id,
          domain: chunk.domain,
          principleHead,
          phase: "done",
          elapsedMs: Date.now() - startedAt,
        });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        failedCount++;
        telemetry.logEvent({
          type: "batch.chunk.fail",
          batchId: batchName,
          chunkId: chunk.id,
          error: err,
          attempt: 0,
        });
        emitter({
          batchId: batchName,
          index: i + 1,
          total: queue.length,
          chunkId: chunk.id,
          domain: chunk.domain,
          principleHead,
          phase: "error",
          error: err,
          elapsedMs: Date.now() - startedAt,
        });
        if (isAbortError(e)) break;
      }

      if (settings.delayMs > 0 && i < queue.length - 1 && !controller.signal.aborted) {
        try {
          await sleep(settings.delayMs, controller.signal);
        } catch {
          break;
        }
      }
    }

    if (controller.signal.aborted && lastProcessedCount === 0) {
      throw new Error("Batch aborted before any chunk completed.");
    }

    let progressAfter: Progress;
    if (!controller.signal.aborted) {
      progressAfter = await finalizeBatch(batchName, batchFile);
    } else {
      progressAfter = await readProgress();
    }

    return {
      batchId: batchName,
      batchName,
      batchFile,
      examplesCount: lastProcessedCount * PHASES.length,
      processedCount: lastProcessedCount,
      failedCount,
      progress: progressAfter,
    };
  } finally {
    coordinator.reportBatchEnd(batchName);
    unregisterDatasetAbort(batchName);
    signal.removeEventListener("abort", onParentAbort);
  }
}
