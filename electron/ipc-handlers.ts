import { ipcMain, type BrowserWindow } from "electron";
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { randomUUID } from "crypto";
import {
  chat,
  listOpenAiModels,
  listDownloaded,
  listLoaded,
  loadModel,
  unloadModel,
  switchProfile,
  getServerStatus,
  PROFILE,
  type ProfileName,
} from "./lmstudio-client";
import {
  generateBatch,
  type BatchSettings,
  type ChunkProgressEvent,
  type BatchResult,
} from "./dataset-generator";
import {
  readProgress,
  listBatchFiles,
  getPaths,
  type Progress,
} from "./finetune-state";
import {
  ALLOWED_DOMAINS,
  PRINCIPLE_MAX,
  PRINCIPLE_MIN,
  EXPLANATION_MAX,
  EXPLANATION_MIN,
} from "./mechanicus-prompt";
import { promises as fs } from "fs";
import * as path from "path";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const SCROLL_LIMIT = 100;
const RAG_TOP_K = 15;
const RAG_SCORE_THRESHOLD = 0.12;
const CHAT_SAMPLING = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0,
  presence_penalty: 0,
  max_tokens: 16384,
} as const;

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

interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

interface QdrantPoint {
  id: string;
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
}

async function fetchQdrantJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Qdrant HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function searchRelevantChunks(
  collection: string,
  query: string,
  limit: number = RAG_TOP_K
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
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

const activeBatches = new Map<string, AbortController>();

export function abortAllBatches(reason: string): void {
  for (const [id, ctrl] of activeBatches.entries()) {
    ctrl.abort(reason);
    activeBatches.delete(id);
  }
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("qdrant:collections", async (): Promise<string[]> => {
    try {
      const data = await fetchQdrantJson<{ result: { collections: Array<{ name: string }> } }>(
        `${QDRANT_URL}/collections`
      );
      return data.result.collections.map((c) => c.name);
    } catch (e) {
      console.error("[qdrant:collections]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("qdrant:points", async (_e, collection: string): Promise<QdrantPoint[]> => {
    try {
      const data = await fetchQdrantJson<{
        result: { points: Array<{ id: string; payload: Record<string, unknown> }> };
      }>(`${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: SCROLL_LIMIT, with_payload: true, with_vector: false }),
      });
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
    const ids = await listOpenAiModels();
    return ids.map((id) => ({ id }));
  });

  ipcMain.handle(
    "lmstudio:chat",
    async (
      _e,
      messages: Array<{ role: string; content: string }>,
      model: string,
      collection: string
    ): Promise<string> => {
      let systemPrompt = "You are a helpful assistant. Respond in Russian.";
      if (collection) {
        try {
          const query = extractUserQuery(messages);
          if (query) {
            const results = await searchRelevantChunks(collection, query);
            if (results.length > 0) {
              systemPrompt = buildRagPrompt(formatChunksForPrompt(results));
              console.log(`[rag:chat] Found ${results.length} relevant chunks`);
            }
          }
        } catch (e) {
          console.error("[rag:chat]", e instanceof Error ? e.message : e);
        }
      }

      const response = await chat({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages] as Array<{
          role: "system" | "user" | "assistant";
          content: string;
        }>,
        sampling: CHAT_SAMPLING,
      });
      return response.content;
    }
  );

  ipcMain.handle(
    "lmstudio:compare",
    async (
      _e,
      messages: Array<{ role: string; content: string }>,
      model: string,
      collection: string
    ): Promise<{
      withoutRag: string;
      withRag: string;
      usageBase?: { prompt: number; completion: number; total: number };
      usageRag?: { prompt: number; completion: number; total: number };
    }> => {
      const baseSystemPrompt = "You are a helpful assistant. Respond in Russian.";
      let ragSystemPrompt = baseSystemPrompt;
      if (collection) {
        try {
          const query = extractUserQuery(messages);
          if (query) {
            const results = await searchRelevantChunks(collection, query);
            if (results.length > 0) {
              ragSystemPrompt = buildRagPrompt(formatChunksForPrompt(results));
            }
          }
        } catch (e) {
          console.error("[rag:compare]", e instanceof Error ? e.message : e);
        }
      }

      const typed = messages as Array<{ role: "system" | "user" | "assistant"; content: string }>;

      const baseResp = await chat({
        model,
        messages: [{ role: "system", content: baseSystemPrompt }, ...typed],
        sampling: CHAT_SAMPLING,
      });
      const ragResp = await chat({
        model,
        messages: [{ role: "system", content: ragSystemPrompt }, ...typed],
        sampling: CHAT_SAMPLING,
      });

      return {
        withoutRag: baseResp.content,
        withRag: ragResp.content,
        usageBase: baseResp.usage,
        usageRag: ragResp.usage,
      };
    }
  );

  ipcMain.handle("lmstudio:status", async () => getServerStatus());
  ipcMain.handle("lmstudio:list-downloaded", async () => listDownloaded());
  ipcMain.handle("lmstudio:list-loaded", async () => listLoaded());
  ipcMain.handle("lmstudio:profiles", async () => PROFILE);

  ipcMain.handle(
    "lmstudio:load",
    async (_e, modelKey: string, opts: { contextLength?: number; ttlSec?: number; gpuOffload?: "max" | number } = {}) =>
      loadModel(modelKey, opts)
  );
  ipcMain.handle("lmstudio:unload", async (_e, identifier: string) => unloadModel(identifier));
  ipcMain.handle(
    "lmstudio:switch-profile",
    async (_e, profileName: ProfileName, contextLength?: number) => switchProfile(profileName, contextLength)
  );

  ipcMain.handle(
    "dataset:start-batch",
    async (_e, settings: BatchSettings): Promise<BatchResult> => {
      const batchId = randomUUID();
      const controller = new AbortController();
      activeBatches.set(batchId, controller);

      const emitter = (event: ChunkProgressEvent): void => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("dataset:chunk-progress", event);
        }
      };

      try {
        return await generateBatch(batchId, controller.signal, settings, emitter);
      } finally {
        activeBatches.delete(batchId);
      }
    }
  );

  ipcMain.handle("dataset:cancel-batch", async (_e, batchId: string): Promise<boolean> => {
    const ctrl = activeBatches.get(batchId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeBatches.delete(batchId);
    return true;
  });

  ipcMain.handle("dataset:get-progress", async (): Promise<Progress | null> => {
    try {
      return await readProgress();
    } catch (e) {
      console.error("[dataset:get-progress]", e instanceof Error ? e.message : e);
      return null;
    }
  });

  ipcMain.handle("dataset:list-batches", async (): Promise<string[]> => listBatchFiles());

  ipcMain.handle(
    "dataset:validate-batch",
    async (_e, batchFile: string): Promise<{ total: number; valid: number; errors: string[] }> => {
      const { batchesDir, sourcePath } = getPaths();
      const batchPath = path.join(batchesDir, path.basename(batchFile));
      try {
        const sourceChunks = JSON.parse(await fs.readFile(sourcePath, "utf8")) as Array<{ id: string }>;
        const validIds = new Set(sourceChunks.map((c) => c.id));
        const raw = (await fs.readFile(batchPath, "utf8")).trim();
        const lines = raw.split("\n");
        const errors: string[] = [];
        let valid = 0;
        for (let i = 0; i < lines.length; i++) {
          const issues = validateLine(lines[i], validIds);
          if (issues.length === 0) valid++;
          else issues.forEach((msg) => errors.push(`Line ${i + 1}: ${msg}`));
        }
        return { total: lines.length, valid, errors };
      } catch (e) {
        return { total: 0, valid: 0, errors: [e instanceof Error ? e.message : String(e)] };
      }
    }
  );
}

function validateLine(line: string, validIds: Set<string>): string[] {
  const errors: string[] = [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return ["Invalid JSON"];
  }

  const conversations = parsed.conversations;
  if (!Array.isArray(conversations) || conversations.length !== 3) {
    errors.push("conversations must have 3 messages");
    return errors;
  }
  const roles = conversations.map((c: Record<string, unknown>) => c.from);
  if (roles[0] !== "system" || roles[1] !== "human" || roles[2] !== "gpt") {
    errors.push(`roles must be [system, human, gpt]`);
  }

  const gptValue = (conversations[2] as Record<string, unknown>).value;
  if (typeof gptValue !== "string") {
    errors.push("gpt.value not a string");
    return errors;
  }
  let chunkData: Record<string, unknown>;
  try {
    chunkData = JSON.parse(gptValue) as Record<string, unknown>;
  } catch {
    errors.push("gpt.value not valid JSON");
    return errors;
  }
  const principle = chunkData.principle;
  if (typeof principle !== "string" || principle.length < PRINCIPLE_MIN || principle.length > PRINCIPLE_MAX) {
    errors.push(`principle out of ${PRINCIPLE_MIN}-${PRINCIPLE_MAX} range`);
  }
  const explanation = chunkData.explanation;
  if (typeof explanation !== "string" || explanation.length < EXPLANATION_MIN || explanation.length > EXPLANATION_MAX) {
    errors.push(`explanation out of ${EXPLANATION_MIN}-${EXPLANATION_MAX} range`);
  }
  if (typeof chunkData.domain !== "string" || !ALLOWED_DOMAINS.has(chunkData.domain)) {
    errors.push(`domain invalid`);
  }
  const tags = chunkData.tags;
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 10) {
    errors.push("tags must be 1-10 items");
  }
  const meta = parsed.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta.source_chunk_id !== "string" || !validIds.has(meta.source_chunk_id)) {
    errors.push("meta.source_chunk_id unknown");
  }
  return errors;
}
