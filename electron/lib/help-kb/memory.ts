/**
 * Agent long-term memory (Phase 4.1, B7 — Karpathy compounding-knowledge).
 *
 * Цель: агент НЕ забывает прошлые разговоры между сессиями. Каждая
 * завершённая user→assistant пара ингестится в Qdrant-коллекцию
 * `bibliary_memory`. Через tool `recall_memory` агент может найти
 * похожие прошлые обсуждения и переиспользовать решения.
 *
 * Это отдельная коллекция от bibliary_help (knowledge о приложении)
 * и от пользовательских книжных коллекций (raw содержимое книг).
 *
 * Privacy: всё хранится локально в Qdrant пользователя, никуда не уходит.
 * Пользователь может в любой момент удалить коллекцию через Qdrant UI.
 *
 * Failure mode: если Qdrant offline — rememberTurn не падает (FAF),
 * лог в console и продолжаем. Агент работает с пустой памятью.
 */

import { createHash } from "crypto";
import { embedPassage, embedQuery } from "../embedder/shared.js";
import { fetchQdrantJson, QDRANT_URL, QDRANT_API_KEY } from "../qdrant/http-client.js";
import { DEFAULT_EMBED_MODEL, EMBEDDING_DIM, EMBED_MAX_INPUT_CHARS } from "../scanner/embedding.js";

export const MEMORY_COLLECTION = "bibliary_memory";

/** Минимальная длина user/assistant message чтобы попасть в память. */
export const MIN_REMEMBER_CHARS = 20;
/** Hard cap на длину одной memory entry чтобы не раздувать payload. */
export const MAX_MEMORY_TEXT_CHARS = 4000;

export interface MemoryEntry {
  ts: string;
  userMessage: string;
  assistantAnswer: string;
  agentId?: string;
}

export interface MemoryHit {
  score: number;
  ts: string;
  userMessage: string;
  assistantAnswer: string;
}

interface QdrantSearchResponse {
  result: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
}

let memoryCollectionEnsured = false;

export function deterministicId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function ensureMemoryCollection(signal?: AbortSignal): Promise<void> {
  if (memoryCollectionEnsured) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
  const probe = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}`, { headers, signal });
  if (probe.ok) {
    memoryCollectionEnsured = true;
    return;
  }
  if (probe.status !== 404) {
    throw new Error(`qdrant memory probe ${probe.status}`);
  }
  const create = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
    signal,
  });
  if (!create.ok) {
    throw new Error(`qdrant memory create ${create.status}`);
  }
  memoryCollectionEnsured = true;
}

export function shouldRemember(entry: MemoryEntry): boolean {
  const u = entry.userMessage.trim();
  const a = entry.assistantAnswer.trim();
  if (u.length < MIN_REMEMBER_CHARS) return false;
  if (a.length < MIN_REMEMBER_CHARS) return false;
  /* Не запоминать чисто-ошибочные ответы */
  if (/^(⚠|ошибка|error)/i.test(a)) return false;
  return true;
}

export function buildMemoryText(entry: MemoryEntry): string {
  /* Embed обоих ролей вместе — это даёт лучший recall на похожих вопросах,
     потому что ответ часто содержит ключевые термины которых не было в
     вопросе. Format совпадает с Karpathy LLM Wiki entry. */
  const u = entry.userMessage.slice(0, MAX_MEMORY_TEXT_CHARS / 2).trim();
  const a = entry.assistantAnswer.slice(0, MAX_MEMORY_TEXT_CHARS / 2).trim();
  return `Q: ${u}\nA: ${a}`;
}

/**
 * Сохранить один user→assistant turn в long-term memory. FAF: ошибки
 * Qdrant/embed не пробрасываются, только логируются. Используется
 * из agent.ipc.ts после успешного finalAnswer.
 */
export async function rememberTurn(entry: MemoryEntry): Promise<{ ok: boolean; reason?: string }> {
  if (!shouldRemember(entry)) {
    return { ok: false, reason: "filtered" };
  }
  try {
    await ensureMemoryCollection();
    const text = buildMemoryText(entry);
    const truncated = text.length > EMBED_MAX_INPUT_CHARS ? text.slice(0, EMBED_MAX_INPUT_CHARS) : text;
    const vector = await embedPassage(truncated, DEFAULT_EMBED_MODEL);
    const id = deterministicId(`${entry.ts}::${entry.userMessage.slice(0, 200)}`);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
    const resp = await fetch(`${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points?wait=false`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        points: [{
          id,
          vector,
          payload: {
            ts: entry.ts,
            userMessage: entry.userMessage.slice(0, MAX_MEMORY_TEXT_CHARS),
            assistantAnswer: entry.assistantAnswer.slice(0, MAX_MEMORY_TEXT_CHARS),
            agentId: entry.agentId ?? null,
          },
        }],
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.warn(`[memory] upsert ${resp.status}: ${txt.slice(0, 200)}`);
      return { ok: false, reason: `qdrant ${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[memory] rememberTurn failed:", e instanceof Error ? e.message : e);
    return { ok: false, reason: e instanceof Error ? e.message : "unknown" };
  }
}

export interface RecallOptions {
  limit?: number;
  scoreThreshold?: number;
  signal?: AbortSignal;
}

const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_RECALL_THRESHOLD = 0.6;

export async function recallMemory(query: string, opts: RecallOptions = {}): Promise<MemoryHit[]> {
  await ensureMemoryCollection(opts.signal);
  const vector = await embedQuery(query, DEFAULT_EMBED_MODEL);
  const data = await fetchQdrantJson<QdrantSearchResponse>(
    `${QDRANT_URL}/collections/${MEMORY_COLLECTION}/points/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit: opts.limit ?? DEFAULT_RECALL_LIMIT,
        with_payload: true,
        score_threshold: opts.scoreThreshold ?? DEFAULT_RECALL_THRESHOLD,
      }),
      signal: opts.signal,
    }
  );
  return data.result.map((r) => ({
    score: r.score,
    ts: String(r.payload.ts ?? ""),
    userMessage: String(r.payload.userMessage ?? ""),
    assistantAnswer: String(r.payload.assistantAnswer ?? ""),
  }));
}
