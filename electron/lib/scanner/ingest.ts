import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { parseBook } from "./parsers/index.js";
import type { ParseOptions } from "./parsers/types.js";
import { chunkBook, type BookChunk, type ChunkerOptions } from "./chunker.js";
import { ScannerStateStore } from "./state.js";
import { DEFAULT_EMBED_MODEL, EMBEDDING_DIM, EMBED_MAX_INPUT_CHARS } from "./embedding.js";

/**
 * Phase 2.6 — Book Ingest pipeline.
 *
 * Pure-Node реализация. Не зависит от Electron API на этом уровне:
 * IPC-обвязка живёт в `electron/ipc/scanner.ipc.ts`.
 *
 * Шаги:
 *   1. parse(file) → ParseResult (sections + metadata)
 *   2. chunk(parsed) → BookChunk[]
 *   3. для каждого chunk: embed("passage: …") → Float32 vector
 *   4. batch upsert в Qdrant (32 chunks за раз)
 *   5. progress: ScannerStateStore.markProgress
 *   6. resume: пропускаем chunkId уже processedChunkIds
 *
 * Гарантии:
 *   - идемпотентность: один chunk = один deterministic uuid от content+source
 *   - resume-safe: после крэша можно дернуть тот же ingest, обработаются
 *     только пропущенные chunks
 *   - не тащит весь .pdf в RAM: парсинг постранично, embed по одному chunk
 */

export interface IngestProgress {
  phase: "parse" | "chunk" | "embed" | "upsert" | "done" | "error";
  bookSourcePath: string;
  bookTitle: string;
  totalChunks: number;
  processedChunks: number;
  embeddedChunks: number;
  upsertedChunks: number;
  message?: string;
  errorMessage?: string;
}

export interface IngestOptions {
  collection: string;
  qdrantUrl: string;
  qdrantApiKey?: string;
  embedModel?: string;
  chunkerOptions?: ChunkerOptions;
  signal?: AbortSignal;
  /** Sync с disk-state. Если не задан — состояние не пишется. */
  state?: ScannerStateStore;
  /** Cap по символам книги — защита от mega-PDF. По умолчанию 5_000_000 (~5 МБ текста). */
  maxBookChars?: number;
  /** Размер batch для upsert. */
  upsertBatch?: number;
  /** Опции, передаваемые в parseBook (OCR флаги, языки, accuracy). */
  parseOptions?: ParseOptions;
  onProgress?: (p: IngestProgress) => void;
}

const DEFAULT_UPSERT_BATCH = 32;
const DEFAULT_MAX_BOOK_CHARS = 5_000_000;

let extractor: FeatureExtractionPipeline | null = null;
let extractorKey: string | null = null;
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Singleton с защитой от race: если два параллельных ingest стартуют до
 * первой загрузки, оба ждут одного Promise вместо двух одновременных init.
 */
async function getExtractor(model: string): Promise<FeatureExtractionPipeline> {
  if (extractor && extractorKey === model) return extractor;
  if (extractorPromise && extractorKey === model) return extractorPromise;
  extractorKey = model;
  extractorPromise = (async () => {
    const m = await pipeline("feature-extraction", model);
    extractor = m;
    return m;
  })();
  return extractorPromise;
}

async function embedPassage(text: string, model: string): Promise<number[]> {
  const ext = await getExtractor(model);
  const out = await ext(`passage: ${text}`, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

async function qdrantUpsert(
  url: string,
  collection: string,
  points: QdrantPoint[],
  apiKey: string | undefined,
  signal?: AbortSignal
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["api-key"] = apiKey;
  const resp = await fetch(`${url}/collections/${encodeURIComponent(collection)}/points?wait=true`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ points }),
    signal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`qdrant upsert ${resp.status}: ${txt.slice(0, 240)}`);
  }
}

async function ensureCollection(
  url: string,
  collection: string,
  apiKey: string | undefined,
  signal?: AbortSignal
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["api-key"] = apiKey;
  const probe = await fetch(`${url}/collections/${encodeURIComponent(collection)}`, { headers, signal });
  if (probe.ok) return;
  if (probe.status !== 404) {
    const txt = await probe.text().catch(() => "");
    throw new Error(`qdrant probe ${probe.status}: ${txt.slice(0, 240)}`);
  }
  const create = await fetch(`${url}/collections/${encodeURIComponent(collection)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
    signal,
  });
  if (!create.ok) {
    const txt = await create.text().catch(() => "");
    throw new Error(`qdrant create ${create.status}: ${txt.slice(0, 240)}`);
  }
  for (const field of ["bookSourcePath", "bookTitle", "tags"] as const) {
    await fetch(`${url}/collections/${encodeURIComponent(collection)}/index`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
      signal,
    }).catch(() => { /* keyword index may already exist */ });
  }
}

export interface IngestResult {
  bookTitle: string;
  totalChunks: number;
  embedded: number;
  upserted: number;
  skipped: number;
  warnings: string[];
}

export async function ingestBook(filePath: string, opts: IngestOptions): Promise<IngestResult> {
  const model = opts.embedModel ?? DEFAULT_EMBED_MODEL;
  const upsertBatch = opts.upsertBatch ?? DEFAULT_UPSERT_BATCH;
  const maxChars = opts.maxBookChars ?? DEFAULT_MAX_BOOK_CHARS;

  const emit = (p: Partial<IngestProgress> & { phase: IngestProgress["phase"]; bookSourcePath: string; bookTitle: string }): void => {
    if (!opts.onProgress) return;
    opts.onProgress({
      totalChunks: 0,
      processedChunks: 0,
      embeddedChunks: 0,
      upsertedChunks: 0,
      ...p,
    });
  };

  emit({ phase: "parse", bookSourcePath: filePath, bookTitle: filePath });
  const parsed = await parseBook(filePath, opts.parseOptions);
  if (parsed.rawCharCount > maxChars) {
    parsed.metadata.warnings.push(`book truncated: rawCharCount=${parsed.rawCharCount} > maxBookChars=${maxChars}`);
  }
  const bookTitle = parsed.metadata.title;

  emit({ phase: "chunk", bookSourcePath: filePath, bookTitle });
  const chunks: BookChunk[] = chunkBook(parsed, filePath, opts.chunkerOptions);
  if (chunks.length === 0) {
    emit({ phase: "done", bookSourcePath: filePath, bookTitle, message: "no extractable text" });
    return { bookTitle, totalChunks: 0, embedded: 0, upserted: 0, skipped: 0, warnings: parsed.metadata.warnings };
  }

  await ensureCollection(opts.qdrantUrl, opts.collection, opts.qdrantApiKey, opts.signal);

  let processedSet = new Set<string>();
  if (opts.state) {
    const cur = await opts.state.read();
    const existing = cur.books[filePath];
    if (existing) processedSet = new Set(existing.processedChunkIds);
    await opts.state.upsertBook({
      bookSourcePath: filePath,
      collection: opts.collection,
      totalChunks: chunks.length,
      processedChunkIds: Array.from(processedSet),
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      status: "running",
    });
  }

  let embedded = 0;
  let upserted = 0;
  let skipped = 0;
  const buf: QdrantPoint[] = [];
  const flushedIds: string[] = [];

  const flush = async (): Promise<void> => {
    if (buf.length === 0) return;
    if (opts.signal?.aborted) throw new Error("ingest aborted");
    await qdrantUpsert(opts.qdrantUrl, opts.collection, buf, opts.qdrantApiKey, opts.signal);
    upserted += buf.length;
    if (opts.state) await opts.state.markProgress(filePath, flushedIds.splice(0));
    emit({
      phase: "upsert",
      bookSourcePath: filePath,
      bookTitle,
      totalChunks: chunks.length,
      processedChunks: embedded + skipped,
      embeddedChunks: embedded,
      upsertedChunks: upserted,
    });
    buf.length = 0;
  };

  try {
    for (const c of chunks) {
      if (opts.signal?.aborted) throw new Error("ingest aborted");
      if (processedSet.has(c.id)) {
        skipped++;
        continue;
      }
      const truncated = c.text.length > EMBED_MAX_INPUT_CHARS ? c.text.slice(0, EMBED_MAX_INPUT_CHARS) : c.text;
      const vector = await embedPassage(truncated, model);
      embedded++;
      buf.push({
        id: c.id,
        vector,
        payload: {
          bookTitle: c.bookTitle,
          bookAuthor: c.bookAuthor ?? null,
          bookSourcePath: c.bookSourcePath,
          chapterTitle: c.chapterTitle,
          chapterIndex: c.chapterIndex,
          chunkIndex: c.chunkIndex,
          text: c.text,
          charCount: c.charCount,
          tags: c.tags,
        },
      });
      flushedIds.push(c.id);
      emit({
        phase: "embed",
        bookSourcePath: filePath,
        bookTitle,
        totalChunks: chunks.length,
        processedChunks: embedded + skipped,
        embeddedChunks: embedded,
        upsertedChunks: upserted,
      });
      if (buf.length >= upsertBatch) await flush();
    }
    await flush();
    if (opts.state) await opts.state.markStatus(filePath, "done");
    emit({
      phase: "done",
      bookSourcePath: filePath,
      bookTitle,
      totalChunks: chunks.length,
      processedChunks: embedded + skipped,
      embeddedChunks: embedded,
      upsertedChunks: upserted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.state) await opts.state.markStatus(filePath, "error", msg);
    emit({
      phase: "error",
      bookSourcePath: filePath,
      bookTitle,
      totalChunks: chunks.length,
      processedChunks: embedded + skipped,
      embeddedChunks: embedded,
      upsertedChunks: upserted,
      errorMessage: msg,
    });
    throw err;
  }

  return {
    bookTitle,
    totalChunks: chunks.length,
    embedded,
    upserted,
    skipped,
    warnings: parsed.metadata.warnings,
  };
}
