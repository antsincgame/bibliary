import {
  chat,
  switchProfile,
  type ChatMessage,
  type SamplingParams,
  type ProfileName,
  PROFILE,
} from "./lmstudio-client";
import {
  readProgress,
  readSourceChunks,
  readGoldExamples,
  commitBatch,
  nextBatchName,
  type SourceChunk,
  type GoldExample,
  type Progress,
} from "./finetune-state";
import { MECHANICUS_SYSTEM_PROMPT } from "./mechanicus-prompt";

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const MODEL_SWITCH_TIMEOUT_MS = 180_000;

export type ChunkPhase = "T1" | "T2" | "T3";

export interface BatchSettings {
  profile: ProfileName;
  contextLength: number;
  batchSize: number;
  delayMs: number;
  fewShotCount: number;
  sampling: Partial<SamplingParams>;
}

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

interface RuntimeContext {
  batchId: string;
  signal: AbortSignal;
  emitter: ProgressEmitter;
  settings: BatchSettings;
}

function fewShotBlock(goldExamples: GoldExample[], domain: string, type: ChunkPhase, limit: number): string {
  if (limit <= 0) return "";
  const matching = goldExamples.filter((ex) => ex.meta.type === type && ex.meta.domain === domain);
  const fallback = goldExamples.filter((ex) => ex.meta.type === type);
  const examples = (matching.length >= limit ? matching : fallback).slice(0, limit);
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

function buildPrompt(chunk: SourceChunk, fewShot: string, type: ChunkPhase): string {
  const requirements: Record<ChunkPhase, string> = {
    T1: `Generate a T1 input — a simulated book excerpt (150-220 words) that would produce this chunk.
Requirements: read like a real book excerpt; varied author voices; self-contained; mix English and Russian across the dataset.`,
    T2: `Generate a T2 input — a practical user question that this chunk answers.
Requirements: real practitioner problem; one concrete question 1-3 sentences; mix Russian and English roughly 50/50.`,
    T3: `Generate a T3 input — a 1-2 line brief idea/hint to be expanded into the full MECHANICUS chunk.
Requirements: compress core idea in 1-2 lines; can be in Russian or English.`,
  };

  return `You are a dataset engineer creating training data for a MECHANICUS knowledge encoder.

${requirements[type]}

${fewShot}

TARGET CHUNK:
${JSON.stringify(chunk, null, 2)}

Generate ONLY the ${type} text. No JSON, no commentary, no labels.`;
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

async function generatePhase(
  ctx: RuntimeContext,
  modelKey: string,
  chunk: SourceChunk,
  goldExamples: GoldExample[],
  type: ChunkPhase
): Promise<string> {
  const fewShot = fewShotBlock(goldExamples, chunk.domain, type, ctx.settings.fewShotCount);
  const userPrompt = buildPrompt(chunk, fewShot, type);
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a dataset engineer. Follow instructions precisely." },
    { role: "user", content: userPrompt },
  ];

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (ctx.signal.aborted) throw new Error("aborted");
    try {
      const response = await chat({
        model: modelKey,
        messages,
        sampling: ctx.settings.sampling,
        signal: ctx.signal,
      });
      return response.content.trim();
    } catch (e) {
      lastError = e;
      if (ctx.signal.aborted) throw new Error("aborted");
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * (attempt + 1), ctx.signal);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
      { from: "system", value: MECHANICUS_SYSTEM_PROMPT },
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

export async function generateBatch(
  batchId: string,
  signal: AbortSignal,
  settings: BatchSettings,
  emitter: ProgressEmitter
): Promise<BatchResult> {
  const profile = PROFILE[settings.profile];
  const [allChunks, progress, goldExamples] = await Promise.all([
    readSourceChunks(),
    readProgress(),
    readGoldExamples(),
  ]);

  const processedSet = new Set(progress.processed_chunk_ids);
  const unprocessed = allChunks.filter((c) => !processedSet.has(c.id));
  const batch = unprocessed.slice(0, settings.batchSize);

  if (batch.length === 0) {
    throw new Error("All chunks have been processed.");
  }

  await withTimeout(
    switchProfile(settings.profile, settings.contextLength),
    MODEL_SWITCH_TIMEOUT_MS,
    `LM Studio model switch exceeded ${MODEL_SWITCH_TIMEOUT_MS / 1000}s`
  );

  const { name: batchName, file: batchFile } = nextBatchName(progress);
  const ctx: RuntimeContext = { batchId, signal, emitter, settings };

  const lines: string[] = [];
  const processedIds: string[] = [];
  let failedCount = 0;

  for (let i = 0; i < batch.length; i++) {
    if (signal.aborted) break;
    const chunk = batch[i];
    const principleHead = chunk.principle.slice(0, 80);
    const startedAt = Date.now();

    try {
      const t1 = await runPhase(ctx, profile.key, chunk, goldExamples, "T1", i, batch.length);
      const t2 = await runPhase(ctx, profile.key, chunk, goldExamples, "T2", i, batch.length);
      const t3 = await runPhase(ctx, profile.key, chunk, goldExamples, "T3", i, batch.length);

      lines.push(buildExampleLine("T1", t1, chunk));
      lines.push(buildExampleLine("T2", t2, chunk));
      lines.push(buildExampleLine("T3", t3, chunk));
      processedIds.push(chunk.id);

      emitter({
        batchId,
        index: i + 1,
        total: batch.length,
        chunkId: chunk.id,
        domain: chunk.domain,
        principleHead,
        phase: "done",
        elapsedMs: Date.now() - startedAt,
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      failedCount++;
      emitter({
        batchId,
        index: i + 1,
        total: batch.length,
        chunkId: chunk.id,
        domain: chunk.domain,
        principleHead,
        phase: "error",
        error: err,
        elapsedMs: Date.now() - startedAt,
      });
      if (err === "aborted") break;
    }

    if (settings.delayMs > 0 && i < batch.length - 1 && !signal.aborted) {
      try {
        await sleep(settings.delayMs, signal);
      } catch {
        break;
      }
    }
  }

  if (lines.length === 0) {
    if (signal.aborted) {
      throw new Error("Batch aborted before any chunk completed.");
    }
    throw new Error(`Batch produced 0 examples (${failedCount} chunks failed).`);
  }

  const newProgress = await commitBatch(batchName, batchFile, lines, processedIds);

  return {
    batchId,
    batchName,
    batchFile,
    examplesCount: lines.length,
    processedCount: processedIds.length,
    failedCount,
    progress: newProgress,
  };
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
  const text = await generatePhase(ctx, modelKey, chunk, goldExamples, type);
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
