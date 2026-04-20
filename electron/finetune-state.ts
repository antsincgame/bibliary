import { promises as fs } from "fs";
import * as path from "path";

const FINETUNE_DIR = path.resolve("data", "finetune");
const PROGRESS_PATH = path.join(FINETUNE_DIR, "progress.json");
const SOURCE_PATH = path.join(FINETUNE_DIR, "source-chunks.json");
const GOLD_PATH = path.join(FINETUNE_DIR, "gold-examples.jsonl");
const BATCHES_DIR = path.join(FINETUNE_DIR, "batches");

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

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => undefined);
  return next;
}

export function getPaths(): {
  finetuneDir: string;
  progressPath: string;
  sourcePath: string;
  goldPath: string;
  batchesDir: string;
} {
  return {
    finetuneDir: FINETUNE_DIR,
    progressPath: PROGRESS_PATH,
    sourcePath: SOURCE_PATH,
    goldPath: GOLD_PATH,
    batchesDir: BATCHES_DIR,
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

export async function commitBatch(
  batchName: string,
  batchFile: string,
  lines: string[],
  processedIds: string[]
): Promise<Progress> {
  return enqueue(async () => {
    await ensureBatchesDir();
    const batchPath = path.join(BATCHES_DIR, batchFile);
    await fs.writeFile(batchPath, lines.join("\n") + "\n", "utf8");

    const progress = await readProgress();
    const newIds = processedIds.filter((id) => !progress.processed_chunk_ids.includes(id));
    progress.processed_chunk_ids.push(...newIds);
    progress.processed_count = progress.processed_chunk_ids.length;
    progress.remaining_count = progress.total_chunks - progress.processed_count;
    progress.batches.push({
      name: batchName,
      file: batchFile,
      chunk_ids: processedIds,
      example_count: lines.length,
      examples_per_chunk: 3,
      created_at: new Date().toISOString().slice(0, 10),
      notes: "Generated via Bibliary UI",
    });
    progress.next_batch_index = Math.max(progress.next_batch_index, parseBatchIndex(batchName) + 1);

    await fs.writeFile(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
    return progress;
  });
}

function parseBatchIndex(batchName: string): number {
  const match = batchName.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

export async function listBatchFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(BATCHES_DIR);
    return entries.filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

export function nextBatchName(progress: Progress): { name: string; file: string } {
  const idx = progress.next_batch_index;
  const name = `batch-${String(idx).padStart(3, "0")}`;
  return { name, file: `${name}.jsonl` };
}
