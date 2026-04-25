/**
 * Help-KB ingest pipeline (Phase 4.1).
 *
 * Цель: превратить docs/*.md в Qdrant-коллекцию `bibliary_help`,
 * чтобы агент мог отвечать на вопросы про САМО приложение через
 * tool `search_help`. Базируется на Karpathy LLM Wiki Pattern:
 * raw sources (docs) → wiki entries (chunks с heading-метаданными)
 * → schema (фиксированный embedding model + Qdrant collection).
 *
 * Hybrid generation (B6):
 *   - Прямой ингест md-чанков (текущая реализация).
 *   - LLM Q&A enrichment планируется отдельной стадией (требует
 *     запущенного LM Studio в момент билда — сейчас опционально).
 *
 * Идемпотентность: deterministic id из (source + headingPath + index).
 * Повторный ингест перезаписывает существующие точки.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { chunkMarkdown, type HelpChunk } from "./chunker.js";
import { embedPassage } from "../embedder/shared.js";
import { DEFAULT_EMBED_MODEL, EMBEDDING_DIM, EMBED_MAX_INPUT_CHARS } from "../scanner/embedding.js";
import { QDRANT_URL, QDRANT_API_KEY } from "../qdrant/http-client.js";

export const HELP_KB_COLLECTION = "bibliary_help";

/**
 * Документы для ингеста. Архивные (UI-TESTER-REPORT, AUDIT-2026-04,
 * TECH-LEAD-REVIEW) сознательно НЕ включаем — они описывают давно
 * устаревшее состояние и сбили бы агента.
 */
const DEFAULT_HELP_DOCS = [
  "FINE-TUNING.md",
  "STATE-OF-PROJECT.md",
  "ROADMAP-TO-MVP.md",
];

export interface HelpKbBuildResult {
  totalChunks: number;
  embedded: number;
  upserted: number;
  warnings: string[];
  durationMs: number;
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

function deterministicId(seed: string): string {
  /* uuid-v4-shaped из sha256(seed). Qdrant принимает 8-4-4-4-12. */
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function ensureHelpCollection(signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
  const probe = await fetch(`${QDRANT_URL}/collections/${HELP_KB_COLLECTION}`, { headers, signal });
  if (probe.ok) return;
  if (probe.status !== 404) {
    const txt = await probe.text().catch(() => "");
    throw new Error(`qdrant probe ${probe.status}: ${txt.slice(0, 240)}`);
  }
  const create = await fetch(`${QDRANT_URL}/collections/${HELP_KB_COLLECTION}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
    signal,
  });
  if (!create.ok) {
    const txt = await create.text().catch(() => "");
    throw new Error(`qdrant create ${create.status}: ${txt.slice(0, 240)}`);
  }
  for (const field of ["source", "docTitle"] as const) {
    await fetch(`${QDRANT_URL}/collections/${HELP_KB_COLLECTION}/index`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
      signal,
    }).catch((err) => console.error("[help-kb/ensurePayloadIndex] Error:", err));
  }
}

async function upsertBatch(points: QdrantPoint[], signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
  const resp = await fetch(`${QDRANT_URL}/collections/${HELP_KB_COLLECTION}/points?wait=true`, {
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

async function loadAndChunkDocs(docsDir: string, files: string[], warnings: string[]): Promise<HelpChunk[]> {
  const all: HelpChunk[] = [];
  for (const file of files) {
    const fullPath = path.join(docsDir, file);
    try {
      const md = await fs.readFile(fullPath, "utf8");
      const basename = path.basename(file, ".md");
      const chunks = chunkMarkdown(md, basename);
      all.push(...chunks);
    } catch (e) {
      warnings.push(`skip ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return all;
}

export interface BuildHelpKbOptions {
  /** Корень docs/ (default: <cwd>/docs). */
  docsDir?: string;
  /** Список .md файлов (default — DEFAULT_HELP_DOCS). */
  files?: string[];
  /** AbortSignal для прерывания. */
  signal?: AbortSignal;
  /** Callback для прогресса (chunks done / total). */
  onProgress?: (done: number, total: number) => void;
  /** Embedding model override. */
  embedModel?: string;
  /** Размер batch для upsert (default 16). */
  upsertBatch?: number;
}

const DEFAULT_UPSERT_BATCH = 16;

export async function buildHelpKb(opts: BuildHelpKbOptions = {}): Promise<HelpKbBuildResult> {
  const startedAt = Date.now();
  const docsDir = opts.docsDir ?? path.resolve("docs");
  const files = opts.files ?? DEFAULT_HELP_DOCS;
  const embedModel = opts.embedModel ?? DEFAULT_EMBED_MODEL;
  const batchSize = opts.upsertBatch ?? DEFAULT_UPSERT_BATCH;
  const warnings: string[] = [];

  await ensureHelpCollection(opts.signal);
  const chunks = await loadAndChunkDocs(docsDir, files, warnings);
  if (chunks.length === 0) {
    return { totalChunks: 0, embedded: 0, upserted: 0, warnings, durationMs: Date.now() - startedAt };
  }

  let embedded = 0;
  let upserted = 0;
  let buffer: QdrantPoint[] = [];

  for (const chunk of chunks) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const text = chunk.text.length > EMBED_MAX_INPUT_CHARS
      ? chunk.text.slice(0, EMBED_MAX_INPUT_CHARS)
      : chunk.text;
    let vector: number[];
    try {
      vector = await embedPassage(text, embedModel);
    } catch (e) {
      warnings.push(`embed fail ${chunk.seed}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    embedded += 1;
    buffer.push({
      id: deterministicId(chunk.seed),
      vector,
      payload: {
        source: chunk.source,
        docTitle: chunk.docTitle,
        headingPath: chunk.headingPath,
        heading: chunk.headingPath[chunk.headingPath.length - 1] ?? chunk.docTitle,
        text: chunk.text,
        charCount: chunk.charCount,
      },
    });
    if (buffer.length >= batchSize) {
      await upsertBatch(buffer, opts.signal);
      upserted += buffer.length;
      buffer = [];
    }
    opts.onProgress?.(embedded, chunks.length);
  }
  if (buffer.length > 0) {
    await upsertBatch(buffer, opts.signal);
    upserted += buffer.length;
  }

  return { totalChunks: chunks.length, embedded, upserted, warnings, durationMs: Date.now() - startedAt };
}
