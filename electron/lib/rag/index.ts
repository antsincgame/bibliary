/**
 * RAG layer — embed + vector search. Используется из qdrant IPC
 * для семантического поиска по коллекциям Qdrant.
 *
 * Singleton embeddingModel — `Xenova/multilingual-e5-small` грузится один раз
 * на процесс. Безопасно для concurrent вызовов: Promise возврата кэшируется.
 */

import { fetchQdrantJson, QDRANT_URL } from "../qdrant/http-client.js";
import { embedQuery as embedQuerySingleton } from "../embedder/shared.js";
import { rerankPassages } from "./reranker.js";

const RAG_TOP_K = 15;

/**
 * Over-fetch множитель для cross-encoder rerank. Логика: dense search
 * быстрый и грубый — берём 4× больше кандидатов чем нужно, потом BGE
 * reranker точно отсеивает мусор.
 *
 * Best practice (Qdrant docs 2026): 3-5× для большинства задач. Для
 * технических корпусов (Bibliary) 4× даёт лучший recall@K без заметной
 * latency penalty (rerank 60 кандидатов ~2-3 сек на CPU).
 *
 * Override через env BIBLIARY_RAG_RERANK_OVERFETCH.
 */
const RAG_RERANK_OVERFETCH = (() => {
  const raw = process.env.BIBLIARY_RAG_RERANK_OVERFETCH;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 20 ? parsed : 4;
})();

/**
 * Жёсткий лимит на сколько кандидатов уходит в rerank. Защита от
 * случайного rerank 1000 chunks (если caller передал слишком большой limit).
 * Cold start модели ~10 сек на первом вызове, per-pair ~50ms — 100 пар
 * это ещё разумно (5 сек), 500+ уже плохо.
 */
const RAG_RERANK_HARD_CAP = 100;

const RAG_SCORE_THRESHOLD = (() => {
  const raw = process.env.BIBLIARY_RAG_SCORE_THRESHOLD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.55;
})();

/**
 * HNSW search parameter `ef` — runtime tuning, balances recall vs latency.
 * Qdrant docs (2026): ef=64 → ~95% recall, ef=128 → ~98%, ef=256 → ~99.5%.
 * Default Qdrant chooses ef = max(top_k, 100).
 *
 * Bibliary RAG calls top_k=15 — at that size, default ef ≈ 100 даёт ~97% recall.
 * Поднимаем до 128 для +1-2% recall (cheap: ~5-10ms latency increase).
 * Override via env BIBLIARY_RAG_HNSW_EF.
 */
const RAG_HNSW_EF = (() => {
  const raw = process.env.BIBLIARY_RAG_HNSW_EF;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 32 && parsed <= 1024 ? parsed : 128;
})();

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

const denseVectorModeCache = new Map<string, "named" | "unnamed">();

/**
 * Достаём флаг `ragRerankEnabled` из preferences. Если store недоступен
 * (вызов из pure-Node бенчмарка), возвращаем true. Caller может override
 * через явный параметр `options.rerank`.
 */
async function resolveRerankEnabled(override?: boolean): Promise<boolean> {
  if (override === false) return false;
  if (override === true) return true;
  try {
    const { getPreferencesStore } = await import("../preferences/store.js");
    const prefs = await getPreferencesStore().getAll();
    return prefs.ragRerankEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * Re-export of the shared singleton embedder. Keeps the public API of
 * this module stable while ensuring scanner/ingest and rag/index share
 * one instance of multilingual-e5-small (saves ~150 MB per process).
 */
export const embedQuery = embedQuerySingleton;

export async function searchRelevantChunks(
  collection: string,
  query: string,
  limit: number = RAG_TOP_K,
  scoreThreshold: number = RAG_SCORE_THRESHOLD,
  timeoutMs?: number,
  options?: { rerank?: boolean },
): Promise<QdrantSearchResult[]> {
  const vector = await embedQuery(query);

  /* Rerank-флаг: caller может явно отключить (rerank=false → dense-only,
     instant). Если caller не передал — пробуем прочитать из preferences;
     если store недоступен (pure-Node script) — оставляем enabled=true. */
  const rerankEnabled = await resolveRerankEnabled(options?.rerank);

  /* Over-fetch только когда будет rerank. Иначе достаточно top-limit. */
  const overfetchLimit = rerankEnabled
    ? Math.min(Math.max(limit, limit * RAG_RERANK_OVERFETCH), RAG_RERANK_HARD_CAP)
    : limit;

  const data = await searchDenseCandidates(collection, vector, overfetchLimit, scoreThreshold, timeoutMs);

  const candidates = data.result;
  if (!rerankEnabled || candidates.length <= 1) return candidates.slice(0, limit);

  /* Извлекаем текст для rerank. Поддерживаем 3 типичных payload-формата:
     - `text` (scanner ingest, help-kb)
     - `essence` (delta-knowledge concepts)
     - `description` (illustrations text-index)
     Если ни одного нет — кандидат всё равно остаётся, но rerank будет
     неинформативным; сортировка сохранит исходный порядок vector score. */
  const withText = candidates.map((c) => {
    const p = c.payload ?? {};
    const text = (
      typeof p.text === "string" ? p.text :
      typeof p.essence === "string" ? p.essence :
      typeof p.description === "string" ? p.description :
      ""
    );
    return { result: c, text };
  });

  /* Graceful degradation: если reranker упал (cold start timeout, OOM,
     отсутствие модели в кэше), возвращаем dense-only top-K. Поиск НЕ
     ломается. Ошибку только логируем — следующий вызов попробует ещё раз. */
  try {
    const reranked = await rerankPassages(
      query,
      withText.map((w) => ({ text: w.text, meta: w.result })),
      limit,
    );
    return reranked.map((r) => (r.candidate.meta as QdrantSearchResult));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[rag] reranker failed, falling back to dense-only: ${msg.slice(0, 200)}`);
    return candidates.slice(0, limit);
  }
}

async function searchDenseCandidates(
  collection: string,
  vector: number[],
  limit: number,
  scoreThreshold: number,
  timeoutMs?: number,
): Promise<{ result: QdrantSearchResult[] }> {
  const url = `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/search`;
  const baseBody = {
    limit,
    with_payload: true,
    score_threshold: scoreThreshold,
    params: { hnsw_ef: RAG_HNSW_EF },
  };

  const mode = denseVectorModeCache.get(collection);
  if (mode === "named") return searchNamedDense(url, baseBody, vector, timeoutMs);
  if (mode === "unnamed") return searchUnnamedDense(url, baseBody, vector, timeoutMs);

  /* Unknown collection shape. Probe meta-endpoint один раз — это надёжнее
     чем гадать через 400. Если probe не сработал — пробуем оба формата
     с unnamed first (большинство prod-коллекций до hybrid миграции — unnamed). */
  const probedMode = await probeCollectionVectorMode(collection, timeoutMs);
  if (probedMode) {
    denseVectorModeCache.set(collection, probedMode);
    return probedMode === "named"
      ? searchNamedDense(url, baseBody, vector, timeoutMs)
      : searchUnnamedDense(url, baseBody, vector, timeoutMs);
  }

  try {
    const unnamed = await searchUnnamedDense(url, baseBody, vector, timeoutMs);
    denseVectorModeCache.set(collection, "unnamed");
    return unnamed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/400|Bad Request|Wrong input|Not existing vector|dense|vector/i.test(msg)) throw e;
    const named = await searchNamedDense(url, baseBody, vector, timeoutMs);
    denseVectorModeCache.set(collection, "named");
    return named;
  }
}

/**
 * Один HTTP-вызов к Qdrant `/collections/{name}` чтобы понять формат вектора
 * (named "dense" vs unnamed). Возвращает null если probe не удался — caller
 * сам fallback'нется на trial+error.
 */
async function probeCollectionVectorMode(
  collection: string,
  timeoutMs?: number,
): Promise<"named" | "unnamed" | null> {
  try {
    const info = await fetchQdrantJson<{
      result: { config?: { params?: { vectors?: unknown } } };
    }>(`${QDRANT_URL}/collections/${encodeURIComponent(collection)}`, {
      method: "GET",
      timeoutMs: timeoutMs ?? 5_000,
    });
    const v = info.result?.config?.params?.vectors;
    if (!v || typeof v !== "object") return null;
    /* Unnamed: { size: 384, distance: "Cosine" }. Named: { dense: {...}, ... }. */
    if ("size" in (v as Record<string, unknown>)) return "unnamed";
    return "named";
  } catch {
    return null;
  }
}

function searchNamedDense(
  url: string,
  baseBody: Record<string, unknown>,
  vector: number[],
  timeoutMs?: number,
): Promise<{ result: QdrantSearchResult[] }> {
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...baseBody, vector: { name: "dense", vector } }),
    timeoutMs,
  });
}

function searchUnnamedDense(
  url: string,
  baseBody: Record<string, unknown>,
  vector: number[],
  timeoutMs?: number,
): Promise<{ result: QdrantSearchResult[] }> {
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...baseBody, vector }),
    timeoutMs,
  });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ result: QdrantSearchResult[] }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchQdrantJson<{ result: QdrantSearchResult[] }>(url, init);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /fetch failed|ECONNRESET|ECONNREFUSED|UND_ERR|timeout/i.test(msg);
      if (!retryable || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 120));
    }
  }
  throw lastErr;
}
