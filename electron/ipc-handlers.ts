import { ipcMain } from "electron";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const SCROLL_LIMIT = 100;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 4096;

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

interface LmStudioModelsResponse {
  data: Array<{ id: string }>;
}

interface LmStudioChatResponse {
  choices: Array<{ message: { content: string } }>;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

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

  ipcMain.handle(
    "lmstudio:chat",
    async (
      _event,
      messages: Array<{ role: string; content: string }>,
      model: string,
      collection: string
    ): Promise<string> => {
      try {
        let concepts = "";
        if (collection) {
          try {
            const scrollData = await fetchJson<QdrantScrollResponse>(
              `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/scroll`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ limit: SCROLL_LIMIT, with_payload: true, with_vector: false }),
              }
            );
            concepts = scrollData.result.points
              .map((p) => String(p.payload.explanation ?? ""))
              .filter(Boolean)
              .join("\n");
          } catch (e) {
            console.error("[qdrant:concepts]", e instanceof Error ? e.message : e);
          }
        }

        const systemPrompt = concepts
          ? `You are an expert assistant with access to a knowledge base. Apply these principles when answering:\n\n${concepts}\n\nRules:\n- Apply these concepts in your response\n- Respond in Russian\n- Give practical, actionable advice\n- Use examples from the concepts when relevant`
          : "You are a helpful assistant. Respond in Russian.";

        const fullMessages = [
          { role: "system", content: systemPrompt },
          ...messages,
        ];

        const data = await fetchJson<LmStudioChatResponse>(`${LM_STUDIO_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: fullMessages,
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
}
