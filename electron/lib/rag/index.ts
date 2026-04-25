/**
 * RAG layer — embed + search + prompt build. Используется из lmstudio IPC
 * (chat / compare с подмешиванием релевантных концептов из Qdrant).
 *
 * Singleton embeddingModel — `Xenova/multilingual-e5-small` грузится один раз
 * на процесс. Безопасно для concurrent вызовов: Promise возврата кэшируется.
 */

import { fetchQdrantJson, QDRANT_URL } from "../qdrant/http-client.js";
import { embedQuery as embedQuerySingleton } from "../embedder/shared.js";

async function loadPrefs() {
  try {
    const { getPreferencesStore } = await import("../preferences/store.js");
    return getPreferencesStore().getAll();
  } catch {
    return null;
  }
}

const RAG_TOP_K = 15;

const RAG_SCORE_THRESHOLD = (() => {
  const raw = process.env.BIBLIARY_RAG_SCORE_THRESHOLD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.55;
})();

const CHAT_SAMPLING = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0,
  presence_penalty: 0,
  max_tokens: 16384,
} as const;

export interface RagConfig {
  topK: number;
  scoreThreshold: number;
  /* S2.2: ранее RAG-search всегда падал в default QDRANT_TIMEOUT_MS (8s)
     даже если пользователь поставил в Settings меньше/больше. Слайдер
     "Qdrant timeout" работал только для bookhunter и dataset-v2. */
  qdrantTimeoutMs: number;
  temperature: number;
  topP: number;
  maxTokens: number;
  /** Ready-to-pass sampling object for `chat({ sampling })`. */
  sampling: {
    temperature: number;
    top_p: number;
    top_k: number;
    min_p: number;
    presence_penalty: number;
    max_tokens: number;
  };
}

export async function getRagConfig(): Promise<RagConfig> {
  const p = await loadPrefs();
  const temperature = p?.chatTemperature ?? CHAT_SAMPLING.temperature;
  const topP = p?.chatTopP ?? CHAT_SAMPLING.top_p;
  const maxTokens = p?.chatMaxTokens ?? CHAT_SAMPLING.max_tokens;
  return {
    topK: p?.ragTopK ?? RAG_TOP_K,
    scoreThreshold: p?.ragScoreThreshold ?? RAG_SCORE_THRESHOLD,
    qdrantTimeoutMs: p?.qdrantTimeoutMs ?? 8000,
    temperature,
    topP,
    maxTokens,
    sampling: {
      ...CHAT_SAMPLING,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
    },
  };
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

/**
 * Re-export of the shared singleton embedder. Keeps the public API of
 * this module stable while ensuring scanner/ingest and rag/index share
 * one instance of multilingual-e5-small (saves ~150 MB per process when
 * ingest and chat run concurrently).
 */
export const embedQuery = embedQuerySingleton;

/**
 * AUDIT MED-2: ранее `score_threshold` всегда брался из константы
 * `RAG_SCORE_THRESHOLD`, игнорируя `prefs.ragScoreThreshold` хоть и
 * `getRagConfig()` его честно читал. UI-слайдер «релевантность ≥ X»
 * фактически не работал. Теперь параметр опциональный с тем же
 * fallback'ом — backward-compatible для всех существующих вызовов.
 */
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

/** Декодирует MECHANICUS-нотацию в читаемый текст для финального prompt. */
export function decodeMechanicus(explanation: string): string {
  return explanation
    .replace(/^X\.\w+\|[\w_]+:\s*/, "")
    .replace(/_/g, " ")
    .replace(/NO:/g, "Avoid:")
    .replace(/eg:/g, "Example:")
    .replace(/>>/g, " → ")
    .replace(/->/g, " → ")
    .replace(/;/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatChunksForPrompt(points: QdrantSearchResult[]): string {
  return points
    .map((p, i) => {
      const principle = String(p.payload.principle ?? "");
      const explanation = String(p.payload.explanation ?? "");
      const decoded = decodeMechanicus(explanation);
      const score = (p.score * 100).toFixed(0);
      return `${i + 1}. [${score}%] ${principle}\n   ${decoded}`;
    })
    .join("\n\n");
}

export function buildRagPrompt(chunks: string): string {
  return [
    "You are Bibliary — an expert knowledge assistant powered by a curated vector database of concepts extracted from professional literature.",
    "Below are knowledge concepts from the user's library that are relevant to their question.",
    "Use these concepts to give a precise, well-grounded answer.",
    "",
    chunks,
    "",
    "INSTRUCTIONS:",
    "- Use the concepts above as your primary knowledge source",
    "- Cite specific principles when they directly answer the question",
    "- If concepts don't cover the question, say so honestly and answer from general knowledge",
    "- Respond in Russian unless the user writes in English",
    "- Be specific: use facts, numbers, concrete details instead of vague claims",
    "- Be concise but thorough",
  ].join("\n");
}

export function extractUserQuery(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}
