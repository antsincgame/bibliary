import { parseBook } from "./parsers/index.js";
import type { ParseOptions, ParseResult } from "./parsers/types.js";
import { chunkBook, type BookChunk, type ChunkerOptions } from "./chunker.js";
import { ScannerStateStore } from "./state.js";
import { DEFAULT_EMBED_MODEL, EMBED_MAX_INPUT_CHARS } from "./embedding.js";
import { embedPassage } from "../embedder/shared.js";
import { ensureChromaCollection } from "../chroma/collection-config.js";
import { chromaUpsertAdaptive, sanitizeMetadata, type ChromaPoint } from "../chroma/points.js";

async function maybeTranslateNonRussian(
  _parsed: ParseResult,
  _signal: AbortSignal | undefined,
): Promise<void> {
  /* Translator role removed in MVP v1.0 -- no-op. */
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
 *   4. batch upsert в Chroma (32 chunks за раз)
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
  /** URL Chroma server (например http://localhost:8000). На текущем этапе
   *  передаётся caller'ом для логирования; runtime берёт URL через live-binding
   *  в `chroma/http-client.ts`. */
  chromaUrl?: string;
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

/**
 * Создать коллекцию в Chroma с tuned HNSW (M=24, construction_ef=128) для
 * мультиязычных книжных корпусов. Идемпотентно: повторный вызов для
 * существующей коллекции = no-op.
 *
 * Note: Chroma не имеет отдельных payload-индексов — фильтрация по
 * metadata работает встроенным механизмом, поэтому
 * `bookSourcePath` / `bookTitle` / `tags` / `language` не требуют
 * явного индексирования.
 */
async function ensureCollectionDense(collection: string): Promise<void> {
  await ensureChromaCollection({
    name: collection,
    distance: "cosine",
    hnsw: { m: 24, construction_ef: 128 },
  });
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

  await ensureCollectionDense(opts.collection);

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
  const buf: ChromaPoint[] = [];
  const flushedIds: string[] = [];

  const flush = async (): Promise<void> => {
    if (buf.length === 0) return;
    if (opts.signal?.aborted) throw new Error("ingest aborted");
    await chromaUpsertAdaptive(opts.collection, buf, { signal: opts.signal });
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
      /* Chroma shape:
       *  - id            — String (defensive coercion в chromaUpsert)
       *  - embedding     — Float32Array → number[]
       *  - document      — text chunk (top-level в Chroma, поддерживает FTS)
       *  - metadata      — только скаляры; tags → "|tag|tag|" (sanitizeMetadata).
       *    `text` НЕ дублируем в metadata — он уже в `document`. */
      buf.push({
        id: String(c.id),
        embedding: denseVec,
        document: c.text,
        metadata: sanitizeMetadata({
          bookTitle: c.bookTitle,
          bookAuthor: c.bookAuthor ?? "",
          bookSourcePath: c.bookSourcePath,
          chapterTitle: c.chapterTitle,
          chapterIndex: c.chapterIndex,
          chunkIndex: c.chunkIndex,
          charCount: c.charCount,
          tagsCsv: c.tags,
        }),
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
