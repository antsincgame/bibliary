import { LMStudioClient } from "@lmstudio/sdk";

const HTTP_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const WS_URL = HTTP_URL.replace(/^http/, "ws");

export const PROFILE = {
  BIG: {
    key: "qwen/qwen3.6-35b-a3b",
    label: "Qwen3.6-35B-A3B",
    quant: "Q4_K_M",
    sizeGB: 22.07,
    minVramGB: 24,
    capabilities: ["vision", "tool", "reasoning"] as const,
    ttlSec: 1800,
  },
  SMALL: {
    key: "qwen/qwen3-4b-2507",
    label: "Qwen3-4B-Instruct-2507",
    quant: "Q8_0",
    sizeGB: 4.28,
    minVramGB: 8,
    capabilities: ["tool"] as const,
    ttlSec: 600,
  },
} as const;

export type ProfileName = keyof typeof PROFILE;

export interface SamplingParams {
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  presence_penalty: number;
  max_tokens: number;
}

export const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0,
  presence_penalty: 1.0,
  max_tokens: 4096,
};

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  sampling?: Partial<SamplingParams>;
  signal?: AbortSignal;
}

export interface ChatUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ChatResponse {
  content: string;
  usage?: ChatUsage;
}

interface OpenAiChatPayload {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  presence_penalty: number;
  max_tokens: number;
}

interface OpenAiChatResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAiModelsResponse {
  data: Array<{ id: string }>;
}

interface DownloadedModelInfo {
  modelKey: string;
  displayName?: string;
  format?: string;
  paramsString?: string;
  architecture?: string;
  quantization?: string;
  sizeBytes?: number;
}

interface LoadedModelInfo {
  identifier: string;
  modelKey: string;
  contextLength?: number;
  quantization?: string;
}

let cachedClient: LMStudioClient | null = null;

function getClient(): LMStudioClient {
  if (!cachedClient) {
    cachedClient = new LMStudioClient({ baseUrl: WS_URL });
  }
  return cachedClient;
}

function dropClient(): void {
  cachedClient = null;
}

async function withSdk<T>(operation: (client: LMStudioClient) => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation(getClient());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[lmstudio-client]", msg);
    if (msg.includes("ECONNREFUSED") || msg.includes("disconnect") || msg.includes("WebSocket")) {
      dropClient();
    }
    return fallback;
  }
}

export async function chat(request: ChatRequest): Promise<ChatResponse> {
  const sampling = { ...DEFAULT_SAMPLING, ...request.sampling };
  const payload: OpenAiChatPayload = {
    model: request.model,
    messages: request.messages,
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    top_k: sampling.top_k,
    min_p: sampling.min_p,
    presence_penalty: sampling.presence_penalty,
    max_tokens: sampling.max_tokens,
  };

  const response = await fetch(`${HTTP_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: request.signal,
  });

  if (!response.ok) {
    throw new Error(`LM Studio HTTP ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as OpenAiChatResponse;
  const choice = data.choices[0];
  if (!choice) {
    throw new Error("LM Studio returned no completion choice");
  }

  return {
    content: choice.message.content,
    usage: data.usage
      ? {
          prompt: data.usage.prompt_tokens ?? 0,
          completion: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

export async function listOpenAiModels(): Promise<string[]> {
  try {
    const response = await fetch(`${HTTP_URL}/v1/models`);
    if (!response.ok) return [];
    const data = (await response.json()) as OpenAiModelsResponse;
    return data.data.map((m) => m.id);
  } catch {
    return [];
  }
}

export async function listDownloaded(): Promise<DownloadedModelInfo[]> {
  return withSdk(
    async (client) => {
      const models = await client.system.listDownloadedModels("llm");
      return models.map((m) => ({
        modelKey: m.modelKey,
        displayName: m.displayName,
        format: m.format,
        paramsString: m.paramsString,
        architecture: m.architecture,
        quantization: m.quantization ? String(m.quantization) : undefined,
        sizeBytes: m.sizeBytes,
      }));
    },
    []
  );
}

export async function listLoaded(): Promise<LoadedModelInfo[]> {
  return withSdk(
    async (client) => {
      const models = await client.llm.listLoaded();
      const infos: LoadedModelInfo[] = [];
      for (const handle of models) {
        const info = await handle.getModelInfo();
        infos.push({
          identifier: info.identifier,
          modelKey: info.modelKey,
          contextLength: info.contextLength,
          quantization: info.quantization ? String(info.quantization) : undefined,
        });
      }
      return infos;
    },
    []
  );
}

export interface LoadOptions {
  contextLength?: number;
  ttlSec?: number;
  gpuOffload?: "max" | number;
}

export async function loadModel(modelKey: string, opts: LoadOptions = {}): Promise<LoadedModelInfo> {
  const client = getClient();
  const handle = await client.llm.load(modelKey, {
    config: {
      contextLength: opts.contextLength,
      gpu: opts.gpuOffload === undefined ? undefined : { ratio: opts.gpuOffload === "max" ? 1 : opts.gpuOffload },
    },
    ttl: opts.ttlSec,
  });
  const info = await handle.getModelInfo();
  return {
    identifier: info.identifier,
    modelKey: info.modelKey,
    contextLength: info.contextLength,
  };
}

export async function unloadModel(identifier: string): Promise<void> {
  const client = getClient();
  await client.llm.unload(identifier);
}

export async function switchProfile(profileName: ProfileName, contextLength = 32768): Promise<LoadedModelInfo> {
  const profile = PROFILE[profileName];
  const loaded = await listLoaded();
  for (const m of loaded) {
    if (m.modelKey !== profile.key) {
      await unloadModel(m.identifier);
    }
  }
  const existing = loaded.find((m) => m.modelKey === profile.key);
  if (existing) return existing;
  return loadModel(profile.key, {
    contextLength,
    ttlSec: profile.ttlSec,
    gpuOffload: "max",
  });
}

export async function getServerStatus(): Promise<{ online: boolean; version?: string }> {
  try {
    const client = getClient();
    const v = await client.system.getLMStudioVersion();
    return { online: true, version: v.version };
  } catch {
    dropClient();
    return { online: false };
  }
}

export function disposeClient(): void {
  if (cachedClient) {
    cachedClient[Symbol.asyncDispose]?.().catch(() => undefined);
    dropClient();
  }
}
