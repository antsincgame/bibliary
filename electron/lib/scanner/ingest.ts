import { parseBook } from "./parsers/index.js";
import type { ParseOptions, ParseResult } from "./parsers/types.js";
import { chunkBook, type BookChunk, type ChunkerOptions } from "./chunker.js";
import { ScannerStateStore } from "./state.js";
import { DEFAULT_EMBED_MODEL, EMBEDDING_DIM, EMBED_MAX_INPUT_CHARS } from "./embedding.js";
import { embedPassage } from "../embedder/shared.js";
import { translateBookSections } from "../llm/translator.js";
import { ensureQdrantCollection } from "../qdrant/collection-config.js";
import { bm25SparseVector } from "../qdrant/bm25-sparse.js";

const NON_RUSSIAN_BUT_TRANSLATABLE = /^(uk|be|kk|ky|tg)/i;

async function maybeTranslateNonRussian(
  parsed: ParseResult,
  signal: AbortSignal | undefined,
): Promise<void> {
  const lang = parsed.metadata.language?.trim() ?? "";
  if (!lang || !NON_RUSSIAN_BUT_TRANSLATABLE.test(lang)) return;

  try {
    const r = await translateBookSections(parsed.sections, {
      sourceLang: lang.slice(0, 2),
      targetLang: "ru",
      signal,
    });
    parsed.metadata.warnings.push(
      `translated to ru: ${r.totalParagraphs} paragraphs, ${r.llmCalls} llm-calls, model=${r.modelKey}` +
      (r.fallbackUsed > 0 ? `, fallback=${r.fallbackUsed}` : ""),
    );
    parsed.metadata.language = "ru";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    parsed.metadata.warnings.push(
      `translation skipped (${lang} → ru): ${msg}. Original text used; configure translator role for full coverage.`,
    );
  }
}

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
  /**
   * Если true — книги на не-русском языке (uk и подобные) переводятся в
   * русский ДО chunking через роль `translator`. Если роль не настроена —
   * warning, идём дальше с оригиналом. Default: false (поведение не меняется
   * для существующих вызовов).
   */
  translateNonRussian?: boolean;
  onProgress?: (p: IngestProgress) => void;
}

const DEFAULT_UPSERT_BATCH = 32;
const DEFAULT_MAX_BOOK_CHARS = 5_000_000;

interface QdrantPoint {
  id: string;
  vector: unknown;
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

async function qdrantUpsertAdaptive(
  url: string,
  collection: string,
  points: QdrantPoint[],
  apiKey: string | undefined,
  signal?: AbortSignal
): Promise<void> {
  if (points.length === 0) return;
  try {
    await qdrantUpsert(url, collection, points, apiKey, signal);
    return;
  } catch (err) {
    if (points.length <= 1) throw err;
    const mid = Math.ceil(points.length / 2);
    await qdrantUpsertAdaptive(url, collection, points.slice(0, mid), apiKey, signal);
    await qdrantUpsertAdaptive(url, collection, points.slice(mid), apiKey, signal);
  }
}

/**
 * Probe + create коллекцию. Новые коллекции создаются как hybrid (dense + BM25
 * sparse) по умолчанию. Существующие не трогаем.
 *
 * Возвращает `true` если коллекция hybrid (named dense + sparse bm25),
 * `false` если legacy unnamed.
 */
async function ensureCollectionHybrid(
  url: string,
  collection: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["api-key"] = apiKey;

  const probe = await fetch(`${url}/collections/${encodeURIComponent(collection)}`, { headers, signal });
  if (probe.ok) {
    try {
      const body = (await probe.json()) as {
        result?: { config?: { params?: { sparse_vectors?: Record<string, unknown> } } };
      };
      const sparse = body.result?.config?.params?.sparse_vectors;
      return !!sparse && typeof sparse === "object" && Object.keys(sparse).length > 0;
    } catch {
      return false;
    }
  }
  if (probe.status !== 404) {
    const txt = await probe.text().catch(() => "");
    throw new Error(`qdrant probe ${probe.status}: ${txt.slice(0, 240)}`);
  }

  const wantHybrid = (process.env.BIBLIARY_INGEST_HYBRID ?? "true").toLowerCase() !== "false";
  await ensureQdrantCollection({
    name: collection,
    vectorSize: EMBEDDING_DIM,
    distance: "Cosine",
    sparseVectors: wantHybrid,
    hnsw: { m: 24, ef_construct: 128 },
    payloadIndexes: [
      { field: "bookSourcePath", type: "keyword" },
      { field: "bookTitle", type: "keyword" },
      { field: "tags", type: "keyword" },
      { field: "language", type: "keyword" },
    ],
  }, url);
  return wantHybrid;
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

  /* Translation gate: книги на украинском (или другом неподдерживаемом
     для большинства моделей языке) переводятся ДО chunking — RAG получит
     чистый русский. Оригинал не сохраняется (по требованию пользователя:
     приоритет русскому переводу). Если translator-роль не настроена —
     warning, продолжаем с оригиналом. */
  if (opts.translateNonRussian) {
    await maybeTranslateNonRussian(parsed, opts.signal);
  }

  const bookTitle = parsed.metadata.title;

  emit({ phase: "chunk", bookSourcePath: filePath, bookTitle });
  const chunks: BookChunk[] = chunkBook(parsed, filePath, opts.chunkerOptions);
  if (chunks.length === 0) {
    if (opts.state) {
      const cur = await opts.state.read();
      const existing = cur.books[filePath];
      await opts.state.upsertBook({
        bookSourcePath: filePath,
        collection: opts.collection,
        totalChunks: 0,
        processedChunkIds: existing?.processedChunkIds ?? [],
        startedAt: existing?.startedAt ?? new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        status: "done",
      });
    }
    emit({ phase: "done", bookSourcePath: filePath, bookTitle, message: "no extractable text" });
    return { bookTitle, totalChunks: 0, embedded: 0, upserted: 0, skipped: 0, warnings: parsed.metadata.warnings };
  }

  const isHybrid = await ensureCollectionHybrid(
    opts.qdrantUrl, opts.collection, opts.qdrantApiKey, opts.signal,
  );

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
    await qdrantUpsertAdaptive(opts.qdrantUrl, opts.collection, buf, opts.qdrantApiKey, opts.signal);
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
      const denseVec = await embedPassage(truncated, model);
      embedded++;
      const vector: unknown = isHybrid
        ? { dense: denseVec, bm25: bm25SparseVector(c.text) }
        : denseVec;
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
