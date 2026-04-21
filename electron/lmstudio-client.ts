import { LMStudioClient } from "@lmstudio/sdk";
import { registerModelContext, unregisterModelContext } from "./lib/token/overflow-guard";
import { withPolicy, buildRequestPolicy, type RequestPolicy, type PolicyContext } from "./lib/resilience/lm-request-policy";
import { getPreferencesStore } from "./lib/preferences/store";
import { getLmStudioUrl, getLmStudioUrlSync } from "./lib/endpoints/index.js";

/**
 * Resolve LM Studio URL on every call. Allows the user to change it in
 * Settings without restarting the app. Sync version used only by the
 * legacy SDK initialisation that runs before any IPC has fired (very
 * early boot); after the first await it always uses the cached value.
 */
function lmStudioHttpUrl(): string {
  return getLmStudioUrlSync();
}
function lmStudioWsUrl(): string {
  return lmStudioHttpUrl().replace(/^http/, "ws");
}

/**
 * Default expected output budget when caller didn't pass one. Used by
 * withPolicy for adaptive timeout. Conservative -- matches DEFAULT_SAMPLING.max_tokens.
 */
const DEFAULT_EXPECTED_TOKENS = 4096;
const DEFAULT_OBSERVED_TPS = 8;

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
  /**
   * Stop sequences (OpenAI-compat). Когда модель сгенерирует одну из строк —
   * генерация останавливается. Полезно для thinking-моделей: после `</think>`
   * можно прекратить, чтобы не жечь токены на пустую генерацию.
   * LM Studio пробрасывает в llama.cpp без модификаций.
   */
  stop?: string[];
  /**
   * Structured output schema (LM Studio 0.4.0+). Обычно `{ type: "json_schema", json_schema: { name, strict: true, schema } }`.
   * Гарантирует, что модель вернёт валидный JSON по схеме (constrained decoding).
   * Не все runtime'ы LM Studio поддерживают одинаково — fallback'и должны быть в caller.
   */
  responseFormat?: Record<string, unknown>;
  /**
   * Qwen-style chat template kwargs (например, `{ enable_thinking: false }` для Qwen3.6).
   * LM Studio 0.4.12+ принимает, но не все модели читают. Безопасный дополнительный
   * рычаг управления thinking-режимом — всегда комбинировать с `stop` и prompt-директивой.
   * См. docs/RESILIENCE.md FAQ.
   */
  chatTemplateKwargs?: Record<string, unknown>;
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
  stop?: string[];
  response_format?: Record<string, unknown>;
  chat_template_kwargs?: Record<string, unknown>;
}

interface OpenAiChatResponse {
  choices: Array<{
    message: { content: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
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
    cachedClient = new LMStudioClient({ baseUrl: lmStudioWsUrl() });
  }
  return cachedClient;
}

/**
 * Drop the SDK client so the next getClient() call rebuilds with the
 * fresh URL from preferences. Use after the user changes LM Studio URL
 * in Settings. The SDK doesn't expose a public disconnect; we just
 * release the reference and let GC + the next reconnect handle cleanup.
 */
export function refreshLmStudioClient(): void {
  cachedClient = null;
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
  if (request.stop && request.stop.length > 0) payload.stop = request.stop;
  if (request.responseFormat) payload.response_format = request.responseFormat;
  if (request.chatTemplateKwargs) payload.chat_template_kwargs = request.chatTemplateKwargs;

  const baseUrl = await getLmStudioUrl();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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

  const content = choice.message.content ?? "";
  const reasoningContent = choice.message.reasoning_content ?? "";
  const finishReason = choice.finish_reason;
  const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

  // Thinking-модели (Qwen3.x, DeepSeek-R1) могут исчерпать max_tokens на reasoning,
  // оставив content="". Бросаем явную ошибку с подсказкой увеличить max_tokens —
  // это понятнее для pipeline чем «empty response».
  if (content.trim().length === 0 && reasoningContent.length > 0 && finishReason === "length") {
    throw new Error(
      `LM Studio: max_tokens exhausted on reasoning (${reasoningTokens} tokens). ` +
        `Increase max_tokens for this thinking-style model.`
    );
  }

  return {
    content,
    usage: data.usage
      ? {
          prompt: data.usage.prompt_tokens ?? 0,
          completion: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/* ────────────────── Phase 4.0 — tools-aware chat ──────────────────
 * Расширение `chat()` для function calling. Не модифицирует существующий
 * `chat()` (Strangler Fig) — добавляет соседнюю функцию с `tools` параметром.
 * Использует тот же endpoint /v1/chat/completions, тот же error-handling.
 *
 * Контракт совместим с OpenAI tools API (Qwen3 4B+ поддерживает native).
 */

/**
 * Сообщение в формате OpenAI tools API. Не наследует `ChatMessage`,
 * потому что добавляет роль `"tool"` и поля `tool_call_id` / `tool_calls`.
 */
export interface ToolMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ToolDefinitionWire {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatWithToolsRequest {
  model: string;
  messages: ToolMessage[];
  tools: ToolDefinitionWire[];
  toolChoice?: "auto" | "none" | "required";
  sampling?: Partial<SamplingParams>;
  signal?: AbortSignal;
  /** См. ChatRequest.stop. */
  stop?: string[];
  /** См. ChatRequest.responseFormat. Реже нужно с tools, но иногда нужно структурировать финальный answer. */
  responseFormat?: Record<string, unknown>;
  /** См. ChatRequest.chatTemplateKwargs. */
  chatTemplateKwargs?: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  argsJson: string;
}

export interface ChatWithToolsResponse {
  content: string;
  toolCalls?: ChatToolCall[];
  finishReason?: string;
  usage?: ChatUsage;
}

interface OpenAiToolCallWire {
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiChatWithToolsResponse {
  choices: Array<{
    message: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: OpenAiToolCallWire[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export async function chatWithTools(request: ChatWithToolsRequest): Promise<ChatWithToolsResponse> {
  const sampling = { ...DEFAULT_SAMPLING, ...request.sampling };
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.toolChoice ?? "auto",
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    top_k: sampling.top_k,
    min_p: sampling.min_p,
    presence_penalty: sampling.presence_penalty,
    max_tokens: sampling.max_tokens,
  };
  if (request.stop && request.stop.length > 0) payload.stop = request.stop;
  if (request.responseFormat) payload.response_format = request.responseFormat;
  if (request.chatTemplateKwargs) payload.chat_template_kwargs = request.chatTemplateKwargs;

  const baseUrl = await getLmStudioUrl();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: request.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LM Studio HTTP ${response.status}: ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }

  const data = (await response.json()) as OpenAiChatWithToolsResponse;
  const choice = data.choices[0];
  if (!choice) throw new Error("LM Studio returned no completion choice");

  const content = choice.message.content ?? "";
  const toolCalls = choice.message.tool_calls?.map((tc) => ({
    id: tc.id ?? `tc_${Math.random().toString(36).slice(2, 12)}`,
    name: tc.function.name,
    argsJson: tc.function.arguments,
  }));

  return {
    content,
    toolCalls,
    finishReason: choice.finish_reason,
    usage: data.usage
      ? {
          prompt: data.usage.prompt_tokens ?? 0,
          completion: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * Build a RequestPolicy from current preferences (with sane fallbacks
 * when the store is not yet initialised, e.g. in unit-tests).
 */
async function loadRuntimePolicy(): Promise<RequestPolicy> {
  try {
    const prefs = await getPreferencesStore().getAll();
    return buildRequestPolicy({
      policyMaxRetries: prefs.policyMaxRetries,
      policyBaseBackoffMs: prefs.policyBaseBackoffMs,
      hardTimeoutCapMs: prefs.hardTimeoutCapMs,
    });
  } catch {
    return buildRequestPolicy({});
  }
}

export interface PolicyContextOverride extends Partial<PolicyContext> {
  /** Outer signal to honor between retries (e.g. user clicked Stop). */
  externalSignal?: AbortSignal;
}

/**
 * Drop-in replacement for `chat()` that runs through the resilience
 * policy: adaptive per-request timeout (based on expected tokens / TPS),
 * exponential backoff retry on transient errors / timeouts, abortGrace
 * around LM Studio bug #1203.
 *
 * Use this from any IPC handler or agent loop where transient
 * disconnects shouldn't fail the whole user action immediately.
 */
export async function chatWithPolicy(
  request: ChatRequest,
  ctx: PolicyContextOverride = {},
): Promise<ChatResponse> {
  const policy = await loadRuntimePolicy();
  const externalSignal = ctx.externalSignal ?? request.signal ?? new AbortController().signal;
  return withPolicy(
    policy,
    externalSignal,
    {
      expectedTokens: ctx.expectedTokens ?? request.sampling?.max_tokens ?? DEFAULT_EXPECTED_TOKENS,
      observedTps: ctx.observedTps ?? DEFAULT_OBSERVED_TPS,
    },
    (innerSignal) => chat({ ...request, signal: innerSignal }),
  );
}

/**
 * Same as chatWithPolicy but for the tools-aware variant. Agent loop
 * uses this so a flaky LM Studio doesn't kill the whole ReAct iteration.
 */
export async function chatWithToolsAndPolicy(
  request: ChatWithToolsRequest,
  ctx: PolicyContextOverride = {},
): Promise<ChatWithToolsResponse> {
  const policy = await loadRuntimePolicy();
  const externalSignal = ctx.externalSignal ?? request.signal ?? new AbortController().signal;
  return withPolicy(
    policy,
    externalSignal,
    {
      expectedTokens: ctx.expectedTokens ?? request.sampling?.max_tokens ?? DEFAULT_EXPECTED_TOKENS,
      observedTps: ctx.observedTps ?? DEFAULT_OBSERVED_TPS,
    },
    (innerSignal) => chatWithTools({ ...request, signal: innerSignal }),
  );
}

export async function listOpenAiModels(): Promise<string[]> {
  try {
    const baseUrl = await getLmStudioUrl();
    const response = await fetch(`${baseUrl}/v1/models`);
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
  if (typeof info.contextLength === "number" && info.contextLength > 0) {
    registerModelContext(info.modelKey, info.contextLength);
  }
  return {
    identifier: info.identifier,
    modelKey: info.modelKey,
    contextLength: info.contextLength,
  };
}

export async function unloadModel(identifier: string): Promise<void> {
  const client = getClient();
  let modelKey: string | null = null;
  try {
    const loaded = await listLoaded();
    modelKey = loaded.find((m) => m.identifier === identifier)?.modelKey ?? null;
  } catch {
    // ignore lookup error
  }
  await client.llm.unload(identifier);
  if (modelKey) unregisterModelContext(modelKey);
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
