import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import {
  withFileLock,
  writeJsonAtomic,
  createCheckpointStore,
  type CheckpointStore,
  coordinator,
  telemetry,
  type PipelineHandle,
} from "./lib/resilience";
import { LINES_PER_CHUNK, type BatchSettings } from "./dataset-generator-config";

const FINETUNE_DIR = path.resolve("data", "finetune");
const PROGRESS_PATH = path.join(FINETUNE_DIR, "progress.json");
const SOURCE_PATH = path.join(FINETUNE_DIR, "source-chunks.json");
const GOLD_PATH = path.join(FINETUNE_DIR, "gold-examples.jsonl");
const BATCHES_DIR = path.join(FINETUNE_DIR, "batches");
const DATASET_CHECKPOINTS_DIR = path.join(FINETUNE_DIR, "checkpoints", "dataset");

export interface BatchManifest {
  name: string;
  file: string;
  chunk_ids: string[];
  example_count: number;
  examples_per_chunk: number;
  created_at: string;
  notes: string;
}

export interface Progress {
  total_chunks: number;
  processed_count: number;
  remaining_count: number;
  processed_chunk_ids: string[];
  batches: BatchManifest[];
  next_batch_index: number;
  examples_per_chunk_target: number;
  batch_size_target: number;
}

export interface SourceChunk {
  id: string;
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
}

export interface GoldExample {
  conversations: Array<{ from: string; value: string }>;
  meta: { type: string; domain: string; source_chunk_id: string; principle_head: string };
}

const DatasetBatchStateSchema = z.object({
  batchName: z.string(),
  batchFile: z.string(),
  startedAt: z.string(),
  lastSavedAt: z.string(),
  processedChunkIds: z.array(z.string()),
  appendedLineCount: z.number().int().nonnegative(),
  linesPerChunk: z.number().int().positive(),
  config: z.unknown(),
  status: z.enum(["running", "paused", "completed"]),
});

export type DatasetBatchState = z.infer<typeof DatasetBatchStateSchema>;

const datasetStore: CheckpointStore<DatasetBatchState> = createCheckpointStore<DatasetBatchState>({
  dir: DATASET_CHECKPOINTS_DIR,
  schema: DatasetBatchStateSchema,
});

export function getDatasetCheckpointStore(): CheckpointStore<DatasetBatchState> {
  return datasetStore;
}

const datasetActiveAborts = new Map<string, AbortController>();

/**
 * Per-batch tracking pending writes — для корректного flushPending без глобальной очереди.
 * При завершении batch очищается, чтобы не накапливать promise chain.
 */
const pendingWritesByBatch = new Map<string, Promise<void>>();

function trackWrite<T>(batchName: string, p: Promise<T>): Promise<T> {
  // suppress reject в tracking promise — иначе любой failed write станет unhandledRejection
  // на следующем .then(). Но реальная ошибка пробрасывается caller'у.
  const swallow = p.then<void, void>(
    () => undefined,
    () => undefined
  );
  const prev = pendingWritesByBatch.get(batchName) ?? Promise.resolve();
  pendingWritesByBatch.set(batchName, prev.then(() => swallow));
  return p;
}

function clearPendingForBatch(batchName: string): void {
  pendingWritesByBatch.delete(batchName);
}

async function flushAllPending(): Promise<void> {
  const all = [...pendingWritesByBatch.values()];
  await Promise.all(all.map((p) => p.catch(() => undefined)));
}

export function registerDatasetAbort(batchId: string, controller: AbortController): void {
  datasetActiveAborts.set(batchId, controller);
}

export function unregisterDatasetAbort(batchId: string): void {
  datasetActiveAborts.delete(batchId);
}

const datasetHandle: PipelineHandle = {
  name: "dataset",
  store: datasetStore as unknown as CheckpointStore<unknown>,
  pause: async (batchId) => {
    const ctl = datasetActiveAborts.get(batchId);
    if (ctl) ctl.abort("paused-by-watchdog");
  },
  resume: async (_batchId) => {
    // resume происходит через UI: пользователь жмёт «Продолжить»
    // и вызывается api.batch.resume → отдельный generateBatch с тем же batchName.
  },
  cancel: async (batchId) => {
    const ctl = datasetActiveAborts.get(batchId);
    if (ctl) ctl.abort("user-cancel");
  },
  discard: async (batchId) => {
    const ctl = datasetActiveAborts.get(batchId);
    if (ctl) ctl.abort("user-discard");
    const state = await datasetStore.load(batchId).catch(() => null);
    if (state) {
      const batchPath = path.join(BATCHES_DIR, state.batchFile);
      await fs.unlink(batchPath).catch(() => undefined);
    }
    await datasetStore.remove(batchId);
    clearPendingForBatch(batchId);
  },
  flushPending: async () => {
    await flushAllPending();
  },
};

let pipelineRegistered = false;

export function registerDatasetPipeline(): void {
  if (pipelineRegistered) return;
  coordinator.registerPipeline(datasetHandle);
  pipelineRegistered = true;
}

export function getPaths(): {
  finetuneDir: string;
  progressPath: string;
  sourcePath: string;
  goldPath: string;
  batchesDir: string;
  checkpointsDir: string;
} {
  return {
    finetuneDir: FINETUNE_DIR,
    progressPath: PROGRESS_PATH,
    sourcePath: SOURCE_PATH,
    goldPath: GOLD_PATH,
    batchesDir: BATCHES_DIR,
    checkpointsDir: DATASET_CHECKPOINTS_DIR,
  };
}

export async function readProgress(): Promise<Progress> {
  const raw = await fs.readFile(PROGRESS_PATH, "utf8");
  return JSON.parse(raw) as Progress;
}

export async function readSourceChunks(): Promise<SourceChunk[]> {
  const raw = await fs.readFile(SOURCE_PATH, "utf8");
  return JSON.parse(raw) as SourceChunk[];
}

export async function readGoldExamples(): Promise<GoldExample[]> {
  const raw = (await fs.readFile(GOLD_PATH, "utf8")).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as GoldExample);
}

export async function ensureBatchesDir(): Promise<void> {
  await fs.mkdir(BATCHES_DIR, { recursive: true });
}

export function nextBatchName(progress: Progress): { name: string; file: string } {
  const idx = progress.next_batch_index;
  const name = `batch-${String(idx).padStart(3, "0")}`;
  return { name, file: `${name}.jsonl` };
}

export async function listBatchFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(BATCHES_DIR);
    return entries.filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

export async function startBatch(
  batchName: string,
  batchFile: string,
  config: BatchSettings,
  resume: boolean = false
): Promise<DatasetBatchState> {
  await ensureBatchesDir();
  const batchPath = path.join(BATCHES_DIR, batchFile);

  if (resume) {
    const existing = await datasetStore.load(batchName);
    if (existing) {
      const reconciled = await reconcileWithJsonl(existing, batchPath);
      reconciled.status = "running";
      reconciled.lastSavedAt = new Date().toISOString();
      await datasetStore.save(batchName, reconciled);
      return reconciled;
    }
  }

  // создаём пустой .jsonl, если его нет (для lockfile)
  try {
    await fs.access(batchPath);
  } catch {
    await fs.writeFile(batchPath, "", "utf8");
  }

  const now = new Date().toISOString();
  const state: DatasetBatchState = {
    batchName,
    batchFile,
    startedAt: now,
    lastSavedAt: now,
    processedChunkIds: [],
    appendedLineCount: 0,
    linesPerChunk: LINES_PER_CHUNK,
    config,
    status: "running",
  };
  await datasetStore.save(batchName, state);
  return state;
}

export async function appendChunkLines(
  batchName: string,
  batchFile: string,
  lines: string[],
  chunkId: string
): Promise<{ progress: Progress; state: DatasetBatchState }> {
  const batchPath = path.join(BATCHES_DIR, batchFile);
  const work = withFileLock(batchPath, async () => {
    const state = await datasetStore.load(batchName);
    if (!state) {
      throw new Error(`appendChunkLines: state for ${batchName} not found`);
    }
    // ИДЕМПОТЕНТНОСТЬ: проверка ДО append — иначе повторный вызов (retry, race
    // между двух процессов после lockfile release) запишет дубликаты строк в .jsonl.
    if (state.processedChunkIds.includes(chunkId)) {
      telemetry.logEvent({
        type: "batch.chunk.ok",
        batchId: batchName,
        chunkId,
        latencyMs: 0,
        recovered: true,
      });
      return { progress: await readProgressOrCreate(), state };
    }

    await fs.appendFile(batchPath, lines.join("\n") + "\n", "utf8");

    state.processedChunkIds.push(chunkId);
    state.appendedLineCount += lines.length;
    state.lastSavedAt = new Date().toISOString();
    await datasetStore.save(batchName, state);

    const progress = await readProgressOrCreate();
    if (!progress.processed_chunk_ids.includes(chunkId)) {
      progress.processed_chunk_ids.push(chunkId);
      progress.processed_count = progress.processed_chunk_ids.length;
      progress.remaining_count = Math.max(0, progress.total_chunks - progress.processed_count);
    }
    await writeJsonAtomic(PROGRESS_PATH, progress);

    return { progress, state };
  });
  return trackWrite(batchName, work);
}

export async function finalizeBatch(
  batchName: string,
  batchFile: string
): Promise<Progress> {
  const batchPath = path.join(BATCHES_DIR, batchFile);
  const work = withFileLock(batchPath, async () => {
    const state = await datasetStore.load(batchName);
    if (!state) {
      throw new Error(`finalizeBatch: state for ${batchName} not found`);
    }
    const expectedLines = state.processedChunkIds.length * state.linesPerChunk;
    if (state.appendedLineCount !== expectedLines) {
      throw new Error(
        `finalizeBatch integrity: appendedLineCount=${state.appendedLineCount} expected=${expectedLines} (chunks=${state.processedChunkIds.length}, perChunk=${state.linesPerChunk})`
      );
    }

    const progress = await readProgressOrCreate();
    if (!progress.batches.find((b) => b.name === batchName)) {
      progress.batches.push({
        name: batchName,
        file: batchFile,
        chunk_ids: [...state.processedChunkIds],
        example_count: state.appendedLineCount,
        examples_per_chunk: state.linesPerChunk,
        created_at: state.startedAt.slice(0, 10),
        notes: "Generated via Bibliary",
      });
    }
    progress.next_batch_index = Math.max(progress.next_batch_index, parseBatchIndex(batchName) + 1);
    await writeJsonAtomic(PROGRESS_PATH, progress);

    await datasetStore.remove(batchName);

    telemetry.logEvent({
      type: "batch.end",
      batchId: batchName,
      ok: state.processedChunkIds.length,
      failed: 0,
      durationMs: Date.now() - new Date(state.startedAt).getTime(),
    });

    clearPendingForBatch(batchName);
    return progress;
  });
  return trackWrite(batchName, work);
}

export async function listUnfinalized(): Promise<DatasetBatchState[]> {
  const items = await datasetStore.scan();
  return items.map((i) => i.snapshot);
}

async function readProgressOrCreate(): Promise<Progress> {
  try {
    return await readProgress();
  } catch {
    const empty: Progress = {
      total_chunks: 0,
      processed_count: 0,
      remaining_count: 0,
      processed_chunk_ids: [],
      batches: [],
      next_batch_index: 0,
      examples_per_chunk_target: LINES_PER_CHUNK,
      batch_size_target: 0,
    };
    return empty;
  }
}

async function reconcileWithJsonl(
  state: DatasetBatchState,
  batchPath: string
): Promise<DatasetBatchState> {
  let raw = "";
  try {
    raw = await fs.readFile(batchPath, "utf8");
  } catch {
    return state;
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  if (lines.length === state.appendedLineCount) {
    return state;
  }
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { meta?: { source_chunk_id?: string } };
      const id = parsed.meta?.source_chunk_id;
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    } catch {
      // skip
    }
  }
  state.processedChunkIds = orderedIds;
  state.appendedLineCount = lines.length;
  state.lastSavedAt = new Date().toISOString();
  telemetry.logEvent({
    type: "batch.chunk.ok",
    batchId: state.batchName,
    chunkId: orderedIds[orderedIds.length - 1] ?? "",
    latencyMs: 0,
    recovered: true,
  });
  return state;
}

function parseBatchIndex(batchName: string): number {
  const match = batchName.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}
