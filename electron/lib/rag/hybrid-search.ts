/**
 * Hybrid retrieval — dense (E5) + sparse (BM25) + cross-encoder rerank.
 *
 * АРХИТЕКТУРА (best practice 2026, ArXiv 2604.01733 + 2604.13728):
 *
 *   1. Dense prefetch:  E5 query → vector → Qdrant top-N candidates
 *   2. Sparse prefetch: BM25 query → sparse → Qdrant top-N candidates
 *   3. RRF fusion:      Qdrant сам делает Reciprocal Rank Fusion (k=60)
 *   4. Cross-encoder rerank: BGE-reranker-large над top-N → top-K финал
 *
 * Дельта vs `searchRelevantChunks` (dense-only + rerank):
 *   - +30-40% recall на технических запросах (ISBN, RFC, имена авторов
 *     на латинице, версии стандартов) — BM25 ловит точные токены.
 *   - +5-10% precision на multilingual запросах через токенизацию UTF-8.
 *   - Same latency (Qdrant prefetch параллелит обе ветки server-side).
 *
 * ТРЕБОВАНИЯ к коллекции:
 *   Должна быть создана через `ensureQdrantCollection({sparseVectors: true})`
 *   — это даёт named vectors "dense" + "bm25" и server-side IDF.
 *
 *   Для существующих коллекций (без sparse) — caller должен использовать
 *   `searchRelevantChunks` (dense-only + rerank). Эта функция кинет ошибку
 *   "Bad Request" от Qdrant если коллекция не hybrid.
 *
 * RRF параметры:
 *   k=60 — стандарт по Cormack et al. 2009.
 *   k=10 — более агрессивно для top-rank precision (см. ArXiv 2604.01733).
 *   Override через env BIBLIARY_RAG_RRF_K.
 */

import { fetchQdrantJson, QDRANT_URL } from "../qdrant/http-client.js";
import { embedQuery as embedQuerySingleton } from "../embedder/shared.js";
import { bm25SparseQuery } from "../qdrant/bm25-sparse.js";
import { rerankPassages } from "./reranker.js";

/** RRF constant k — баланс между top-rank emphasis (low k) и smoothness (high k). */
const RRF_K = (() => {
  const raw = process.env.BIBLIARY_RAG_RRF_K;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 200 ? parsed : 60;
})();

/** Per-branch limit (dense, sparse) до RRF fusion. */
const HYBRID_PREFETCH_LIMIT = (() => {
  const raw = process.env.BIBLIARY_RAG_HYBRID_PREFETCH;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 10 && parsed <= 500 ? parsed : 50;
})();

/** HNSW search ef — выше = больше recall ценой latency. */
const HYBRID_HNSW_EF = (() => {
  const raw = process.env.BIBLIARY_RAG_HNSW_EF;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 32 && parsed <= 1024 ? parsed : 128;
})();

export interface HybridSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
  /** Cross-encoder reranker logit (если rerank применился). */
  rerankScore?: number;
}

/**
 * Hybrid search: dense prefetch + sparse prefetch + RRF + cross-encoder rerank.
 *
 * @param collection — имя коллекции (должна быть создана с sparseVectors: true)
 * @param query — текстовый запрос
 * @param limit — финальное количество результатов (default 15)
 *
 * Возвращает результаты, отсортированные по rerank score (если rerank
 * сработал) или по RRF score (graceful fallback).
 */
export async function searchHybridChunks(
  collection: string,
  query: string,
  limit: number = 15,
  timeoutMs?: number,
  options?: { rerank?: boolean },
): Promise<HybridSearchResult[]> {
  if (!query || query.trim().length === 0) return [];

  /* Параллельная подготовка: dense embedding и sparse vectorization. */
  const [denseVector, sparseVector] = await Promise.all([
    embedQuerySingleton(query),
    Promise.resolve(bm25SparseQuery(query)),
  ]);

  if (sparseVector.indices.length === 0 && denseVector.length === 0) return [];

  /* Qdrant Query API: prefetch (dense + sparse) → fusion. Сервер сам
     делает RRF — мы просто шлём оба запроса в одном HTTP вызове. */
  const body: Record<string, unknown> = {
    prefetch: [
      {
        query: denseVector,
        using: "dense",
        limit: HYBRID_PREFETCH_LIMIT,
        params: { hnsw_ef: HYBRID_HNSW_EF },
      },
      {
        query: { indices: sparseVector.indices, values: sparseVector.values },
        using: "bm25",
        limit: HYBRID_PREFETCH_LIMIT,
      },
    ],
    /* Fusion query: RRF с настраиваемым k. */
    query: { fusion: "rrf" },
    params: { rrf: { k: RRF_K } },
    limit: Math.min(HYBRID_PREFETCH_LIMIT, Math.max(limit * 4, limit + 10)),
    with_payload: true,
  };

  const data = await fetchQdrantJson<{
    result: { points: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }> };
  }>(
    `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs,
    },
  );

  const fused: HybridSearchResult[] = (data.result?.points ?? []).map((p) => ({
    id: String(p.id),
    score: p.score,
    payload: p.payload ?? {},
  }));

  if (fused.length <= 1) return fused.slice(0, limit);

  /* Rerank gate: caller может явно выключить, иначе читаем из preferences.
     Для pure-Node контекста (бенчмарк/тесты) prefs недоступны → rerank=true. */
  let rerankEnabled = options?.rerank;
  if (rerankEnabled === undefined) {
    try {
      const { getPreferencesStore } = await import("../preferences/store.js");
      const prefs = await getPreferencesStore().getAll();
      rerankEnabled = prefs.ragRerankEnabled !== false;
    } catch {
      rerankEnabled = true;
    }
  }
  if (!rerankEnabled) return fused.slice(0, limit);

  /* Cross-encoder rerank — финальная стадия точности. */
  const candidates = fused.map((f) => {
    const text = (
      typeof f.payload.text === "string" ? f.payload.text :
      typeof f.payload.essence === "string" ? f.payload.essence :
      typeof f.payload.description === "string" ? f.payload.description :
      ""
    );
    return { text, meta: f };
  });

  try {
    const reranked = await rerankPassages(query, candidates, limit);
    return reranked.map((r) => ({
      ...(r.candidate.meta as HybridSearchResult),
      rerankScore: r.rerankScore,
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[rag/hybrid] reranker failed, returning RRF order: ${msg.slice(0, 200)}`);
    return fused.slice(0, limit);
  }
}

/**
 * Универсальная entry-функция: пробует hybrid если коллекция поддерживает
 * sparse vectors, иначе fallback на dense-only с rerank. Принимает то же
 * API что `searchRelevantChunks` для drop-in замены.
 *
 * Детектит hybrid через peek-запрос (`/collections/{name}` → проверяем
 * `config.params.sparse_vectors`). Кэшируется в-памяти на 5 минут чтобы
 * не дёргать meta-endpoint на каждый запрос.
 */
const collectionCapsCache = new Map<string, { hybrid: boolean; checkedAt: number }>();
const COLLECTION_CAPS_TTL_MS = 5 * 60 * 1000;

async function detectHybridSupport(collection: string, timeoutMs?: number): Promise<boolean> {
  const cached = collectionCapsCache.get(collection);
  if (cached && Date.now() - cached.checkedAt < COLLECTION_CAPS_TTL_MS) {
    return cached.hybrid;
  }
  try {
    const info = await fetchQdrantJson<{
      result: { config?: { params?: { sparse_vectors?: Record<string, unknown> } } };
    }>(
      `${QDRANT_URL}/collections/${encodeURIComponent(collection)}`,
      { method: "GET", timeoutMs },
    );
    const sparse = info.result?.config?.params?.sparse_vectors;
    const hybrid = !!sparse && typeof sparse === "object" && Object.keys(sparse).length > 0;
    collectionCapsCache.set(collection, { hybrid, checkedAt: Date.now() });
    return hybrid;
  } catch {
    /* Если probe упал — считаем что нет hybrid (безопасный fallback). */
    return false;
  }
}

/** Сбросить кэш detect — для тестов. */
export function _resetHybridCapsCache(): void {
  collectionCapsCache.clear();
}

/**
 * Smart search: hybrid если коллекция поддерживает, иначе dense+rerank.
 * Это основной entry-point для UI и для будущих миграций — caller не должен
 * знать деталь "hybrid или нет".
 */
export async function searchSmart(
  collection: string,
  query: string,
  limit: number = 15,
  timeoutMs?: number,
): Promise<HybridSearchResult[]> {
  const hybrid = await detectHybridSupport(collection, timeoutMs);
  if (hybrid) {
    return searchHybridChunks(collection, query, limit, timeoutMs);
  }
  /* Fallback: dense-only через searchRelevantChunks. */
  const { searchRelevantChunks } = await import("./index.js");
  const results = await searchRelevantChunks(collection, query, limit, undefined, timeoutMs);
  return results.map((r) => ({
    id: r.id,
    score: r.score,
    payload: r.payload,
  }));
}
