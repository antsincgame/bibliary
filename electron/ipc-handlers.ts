import { ipcMain } from "electron";
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const SCROLL_LIMIT = 100;
const RAG_TOP_K = 15;
const RAG_SCORE_THRESHOLD = 0.12;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 16384;

// ── Embedding model (lazy loaded) ──────────────────────────────

let embeddingModel: FeatureExtractionPipeline | null = null;

async function getEmbeddingModel(): Promise<FeatureExtractionPipeline> {
  if (!embeddingModel) {
    console.log("[embed] Loading multilingual-e5-small…");
    embeddingModel = await pipeline("feature-extraction", "Xenova/multilingual-e5-small");
    console.log("[embed] Model ready.");
  }
  return embeddingModel;
}

async function embedQuery(text: string): Promise<number[]> {
  const model = await getEmbeddingModel();
  const output = await model(`query: ${text}`, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

// ── MECHANICUS decoder ─────────────────────────────────────────

function decodeMechanicus(explanation: string): string {
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

// ── Interfaces ─────────────────────────────────────────────────

interface QdrantPoint {
  id: string;
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
}

interface QdrantCollectionsResponse {
  result: { collections: Array<{ name: string }> };
}

interface QdrantScrollResponse {
  result: {
    points: Array<{
      id: string;
      payload: Record<string, unknown>;
    }>;
  };
}

interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

interface QdrantSearchResponse {
  result: QdrantSearchResult[];
}

interface LmStudioModelsResponse {
  data: Array<{ id: string }>;
}

interface LmStudioChatResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ── Helpers ────────────────────────────────────────────────────

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function searchRelevantChunks(
  collection: string,
  query: string,
  limit: number = RAG_TOP_K
): Promise<QdrantSearchResult[]> {
  const vector = await embedQuery(query);
  const data = await fetchJson<QdrantSearchResponse>(
    `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        score_threshold: RAG_SCORE_THRESHOLD,
      }),
    }
  );
  return data.result;
}

function formatChunksForPrompt(points: QdrantSearchResult[]): string {
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

function buildRagPrompt(chunks: string): string {
  return [
    "You are an expert copywriter and SEO specialist.",
    "Below are editorial rules relevant to the user's request — apply them silently to produce superior text.",
    "",
    chunks,
    "",
    "INSTRUCTIONS:",
    "- Apply these rules silently — NEVER list, cite, name, or explain them in your output",
    "- Write naturally, as if this expertise is your own",
    "- Respond in Russian",
    "- Be specific: use facts, numbers, concrete details instead of vague claims",
    "- Produce text at least as long and detailed as you would without these rules",
  ].join("\n");
}

function extractUserQuery(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i].content;
    }
  }
  return "";
}

// ── IPC Handlers ───────────────────────────────────────────────

export function registerIpcHandlers(): void {
  ipcMain.handle("qdrant:collections", async (): Promise<string[]> => {
    try {
      const data = await fetchJson<QdrantCollectionsResponse>(`${QDRANT_URL}/collections`);
      return data.result.collections.map((c) => c.name);
    } catch (e) {
      console.error("[qdrant:collections]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("qdrant:points", async (_event, collection: string): Promise<QdrantPoint[]> => {
    try {
      const data = await fetchJson<QdrantScrollResponse>(
        `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/scroll`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: SCROLL_LIMIT, with_payload: true, with_vector: false }),
        }
      );

      return data.result.points.map((p) => ({
        id: String(p.id),
        principle: String(p.payload.principle ?? ""),
        explanation: String(p.payload.explanation ?? ""),
        domain: String(p.payload.domain ?? ""),
        tags: Array.isArray(p.payload.tags) ? p.payload.tags.map(String) : [],
      }));
    } catch (e) {
      console.error("[qdrant:points]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("lmstudio:models", async (): Promise<Array<{ id: string }>> => {
    try {
      const data = await fetchJson<LmStudioModelsResponse>(`${LM_STUDIO_URL}/v1/models`);
      return data.data.map((m) => ({ id: m.id }));
    } catch (e) {
      console.error("[lmstudio:models]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  // ── Chat with semantic RAG ──────────────────────────────────

  ipcMain.handle(
    "lmstudio:chat",
    async (
      _event,
      messages: Array<{ role: string; content: string }>,
      model: string,
      collection: string
    ): Promise<string> => {
      try {
        let systemPrompt = "You are a helpful assistant. Respond in Russian.";

        if (collection) {
          try {
            const query = extractUserQuery(messages);
            if (query) {
              const results = await searchRelevantChunks(collection, query);
              if (results.length > 0) {
                const chunks = formatChunksForPrompt(results);
                systemPrompt = buildRagPrompt(chunks);
                console.log(`[rag:chat] Found ${results.length} relevant chunks for query`);
              }
            }
          } catch (e) {
            console.error("[rag:chat]", e instanceof Error ? e.message : e);
          }
        }

        const data = await fetchJson<LmStudioChatResponse>(`${LM_STUDIO_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: systemPrompt }, ...messages],
            temperature: DEFAULT_TEMPERATURE,
            max_tokens: DEFAULT_MAX_TOKENS,
          }),
        });

        const choice = data.choices[0];
        if (!choice) {
          throw new Error("No response from model");
        }
        return choice.message.content;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[lmstudio:chat]", msg);
        throw new Error(msg);
      }
    }
  );

  // ── Compare mode (without RAG vs with RAG) ──────────────────

  ipcMain.handle(
    "lmstudio:compare",
    async (
      _event,
      messages: Array<{ role: string; content: string }>,
      model: string,
      collection: string
    ): Promise<{ withoutRag: string; withRag: string; usageBase?: { prompt: number; completion: number; total: number }; usageRag?: { prompt: number; completion: number; total: number } }> => {
      try {
        const baseSystemPrompt = "You are a helpful assistant. Respond in Russian.";

        let ragSystemPrompt = baseSystemPrompt;
        if (collection) {
          try {
            const query = extractUserQuery(messages);
            if (query) {
              const results = await searchRelevantChunks(collection, query);
              if (results.length > 0) {
                const chunks = formatChunksForPrompt(results);
                ragSystemPrompt = buildRagPrompt(chunks);
                console.log(`[rag:compare] Found ${results.length} relevant chunks for query`);
              }
            }
          } catch (e) {
            console.error("[rag:compare]", e instanceof Error ? e.message : e);
          }
        }

        const chatRequest = (systemPrompt: string) =>
          fetchJson<LmStudioChatResponse>(`${LM_STUDIO_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              messages: [{ role: "system", content: systemPrompt }, ...messages],
              temperature: DEFAULT_TEMPERATURE,
              max_tokens: DEFAULT_MAX_TOKENS,
            }),
          });

        const withoutRagData = await chatRequest(baseSystemPrompt);
        const withoutRag = withoutRagData.choices[0]?.message.content ?? "No response";
        const usageBase = withoutRagData.usage
          ? { prompt: withoutRagData.usage.prompt_tokens ?? 0, completion: withoutRagData.usage.completion_tokens ?? 0, total: withoutRagData.usage.total_tokens ?? 0 }
          : undefined;

        const withRagData = await chatRequest(ragSystemPrompt);
        const withRag = withRagData.choices[0]?.message.content ?? "No response";
        const usageRag = withRagData.usage
          ? { prompt: withRagData.usage.prompt_tokens ?? 0, completion: withRagData.usage.completion_tokens ?? 0, total: withRagData.usage.total_tokens ?? 0 }
          : undefined;

        return { withoutRag, withRag, usageBase, usageRag };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[lmstudio:compare]", msg);
        throw new Error(msg);
      }
    }
  );
}
