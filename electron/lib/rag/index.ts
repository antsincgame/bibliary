/**
 * RAG layer — embed + vector search. Используется из qdrant IPC
 * для семантического поиска по коллекциям Qdrant.
 *
 * Singleton embeddingModel — `Xenova/multilingual-e5-small` грузится один раз
 * на процесс. Безопасно для concurrent вызовов: Promise возврата кэшируется.
 */

import { fetchQdrantJson, QDRANT_URL } from "../qdrant/http-client.js";
import { embedQuery as embedQuerySingleton } from "../embedder/shared.js";

const RAG_TOP_K = 15;

const RAG_SCORE_THRESHOLD = (() => {
  const raw = process.env.BIBLIARY_RAG_SCORE_THRESHOLD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.55;
})();

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
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
): Promise<QdrantSearchResult[]> {
  const vector = await embedQuery(query);
  const data = await fetchQdrantJson<{ result: QdrantSearchResult[] }>(
    `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        score_threshold: scoreThreshold,
      }),
      timeoutMs,
    }
  );
  return data.result;
}
