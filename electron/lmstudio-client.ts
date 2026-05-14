import { LMStudioClient } from "@lmstudio/sdk";
import { registerModelContext, unregisterModelContext } from "./lib/token/overflow-guard.js";
import { withPolicy, buildRequestPolicy, type RequestPolicy, type PolicyContext } from "./lib/resilience/lm-request-policy.js";
import { getPreferencesStore } from "./lib/preferences/store.js";
import { getLmStudioUrl, getLmStudioUrlSync } from "./lib/endpoints/index.js";
import { runExclusiveOnModel } from "./lib/llm/model-inference-lock.js";

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
  /**
   * Содержимое поля `reasoning_content` для thinking-моделей (Qwen3.x, DeepSeek-R1).
   * При `response_format=json_schema` LM Studio часто кладёт сюда финальный JSON
   * вместо `content` (см. LM Studio bug-tracker #1773 / #1698 / #1602). Caller
   * (например, concept-extractor) должен иметь fallback на reasoning_content
   * через `extractJsonFromReasoning()` из `lib/dataset-v2/reasoning-decoder`.
   */
  reasoningContent?: string;
  /** finish_reason из OpenAI-compat ответа: "stop" | "length" | "content_filter" | ... */
  finishReason?: string;
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

export interface DownloadedModelInfo {
  modelKey: string;
  displayName?: string;
  format?: string;
  paramsString?: string;
  architecture?: string;
  quantization?: string;
  sizeBytes?: number;
}

/**
 * Информация о загруженной в LM Studio модели. Поля `vision` и
 * `trainedForToolUse` — эвристика по `modelKey` (LM Studio SDK не предоставляет
 * флагов capabilities). Используется в auto-config (`electron/lib/llm/auto-config.ts`)
 * для эвристического распределения reader/extractor/vision-ocr задач.
 */
export interface LoadedModelInfo {
  identifier: string;
  modelKey: string;
  contextLength?: number;
  quantization?: string;
  /** True если modelKey матчит vision-маркеры (qwen3-vl, llava, pixtral, ...). */
  vision?: boolean;
  /** True если модель эвристически выглядит как обученная под tool-calling. */
  trainedForToolUse?: boolean;
}

let cachedClient: LMStudioClient | null = null;

function getClient(): LMStudioClient {
  if (!cachedClient) {
    const wsUrl = ipv4FallbackUrl ?? lmStudioWsUrl();
    cachedClient = new LMStudioClient({ baseUrl: wsUrl });
  }
  return cachedClient;
}

/**
 * Drop the SDK client so the next getClient() call rebuilds with the
 * fresh URL from preferences. Use after the user changes LM Studio URL
 * in Settings.
 *
 * Iter 14.4 (2026-05-04): explicitly dispose old client so its WebSocket
 * doesn't keep the process alive or show as a zombie in LM Studio.
 */
export function refreshLmStudioClient(): void {
  if (cachedClient) {
    cachedClient[Symbol.asyncDispose]?.().catch(() => {});
  }
  cachedClient = null;
  ipv4FallbackUrl = null;
}

function dropClient(): void {
  if (cachedClient) {
    cachedClient[Symbol.asyncDispose]?.().catch(() => {});
  }
  cachedClient = null;
}

const SDK_TIMEOUT_MS = 8_000;

/**
 * Track whether we already discovered that localhost needs IPv4 fallback.
 * Once the fallback succeeds we cache the resolved URL so we don't
 * re-probe on every SDK call. Reset on `refreshLmStudioClient` (user
 * changed URL in Settings) or after a successful primary attempt.
 */
let ipv4FallbackUrl: string | null = null;

function isLocalhostUrl(url: string): boolean {
  try { return new URL(url).hostname === "localhost"; } catch { return false; }
}

function makeIpv4Url(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "localhost") return null;
    u.hostname = "127.0.0.1";
    return u.toString().replace(/\/$/, "");
  } catch { return null; }
}

function isRetryableConnectionError(msg: string): boolean {
  return /ECONNREFUSED|disconnect|WebSocket|timeout/i.test(msg);
}

async function withSdk<T>(operation: (client: LMStudioClient) => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      operation(getClient()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("LM Studio SDK timeout")), SDK_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (ipv4FallbackUrl) {
      ipv4FallbackUrl = null;
    }
    return result;
  } catch (e) {
    if (timer) clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[lmstudio-client]", msg);

    if (isRetryableConnectionError(msg)) {
      dropClient();

      /* IPv4 fallback: on Windows, localhost often resolves to ::1 (IPv6)
         while LM Studio listens on 0.0.0.0 (IPv4 only). When the primary
         ws://localhost:PORT fails with ECONNREFUSED/timeout, we retry once
         with ws://127.0.0.1:PORT. If that succeeds we cache the fallback
         URL so all subsequent SDK calls go there directly. */
      const httpUrl = lmStudioHttpUrl();
      if (!ipv4FallbackUrl && isLocalhostUrl(httpUrl)) {
        const wsIpv4 = makeIpv4Url(lmStudioWsUrl());
        if (wsIpv4) {
          console.warn("[lmstudio-client] IPv4 fallback: trying", wsIpv4);
          cachedClient = new LMStudioClient({ baseUrl: wsIpv4 });
          let timer2: ReturnType<typeof setTimeout> | null = null;
          try {
            const r2 = await Promise.race([
              operation(cachedClient),
              new Promise<never>((_, rej) => {
                timer2 = setTimeout(() => rej(new Error("LM Studio SDK timeout (IPv4 fallback)")), SDK_TIMEOUT_MS);
                timer2.unref();
              }),
            ]);
            if (timer2) clearTimeout(timer2);
            ipv4FallbackUrl = wsIpv4;
            console.warn("[lmstudio-client] IPv4 fallback succeeded — caching", wsIpv4);
            return r2;
          } catch (e2) {
            if (timer2) clearTimeout(timer2);
            const msg2 = e2 instanceof Error ? e2.message : String(e2);
            console.error("[lmstudio-client] IPv4 fallback also failed:", msg2);
            dropClient();
          }
        }
      }
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
  /* Per-modelKey serialization (см. model-inference-lock.ts).
     Защита от каскадных empty-responses при параллельных запросах
     evaluator / vision-meta / vision-illustration / text-meta на одну
     физическую модель. Между разными моделями параллелизм сохранён. */
  const data = await runExclusiveOnModel(request.model, async () => {
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

    return (await response.json()) as OpenAiChatResponse;
  });

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
    reasoningContent: reasoningContent.length > 0 ? reasoningContent : undefined,
    finishReason,
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

/**
 * Маркеры моделей, которые тренировались с tool-calling в SFT/RL стадии.
 * Это эвристика: реальный SDK-флаг отсутствует, поэтому ориентируемся
 * на хорошо задокументированные семейства. Список консервативен —
 * лучше пропустить менее проверенную модель, чем дать резолверу agent
 * роль модели которая не умеет в tool-calling.
 */
const TOOL_USE_MARKERS: ReadonlyArray<string> = [
  "qwen3",         /* Qwen3 series — explicit tool-use training */
  "qwen2.5",       /* Qwen2.5-Instruct — strong tool-use */
  "llama-3.1",     /* Llama 3.1 Instruct — tool-use baked in */
  "llama-3.2",
  "llama-3.3",
  "mistral-7b-instruct-v0.3", /* Mistral v0.3+ supports tools */
  "mistral-large",
  "mixtral",
  "hermes-3",      /* Nous Research Hermes 3 — tool-use focused */
  "command-r",     /* Cohere Command R+ */
  "phi-4",         /* Phi-4 series */
  "deepseek-v3",
  "deepseek-r1",
];

export function looksLikeToolUseModel(modelKey: string): boolean {
  if (!modelKey) return false;
  const lc = modelKey.toLowerCase();
  return TOOL_USE_MARKERS.some((m) => lc.includes(m));
}

/**
 * Легковесная inline-эвристика vision-моделей. Дублирует логику
 * `looksLikeVisionModel` из `lib/llm/vision-meta.ts`, но без импорта чтобы
 * избежать circular dependency: vision-meta.ts → lmstudio-client.ts (listLoaded)
 * → vision-meta.ts. Список маркеров короче (только надёжно vision-only),
 * полная эвристика (с env-override) остаётся в vision-meta.
 */
const VISION_MARKERS_INLINE: ReadonlyArray<string> = [
  "qwen3.5", "-vl", "vision", "llava", "pixtral",
  "minicpm-v", "molmo", "gemma-3", "gemma3",
  "phi-3.5-vision", "phi-4-multimodal", "phi-vision",
  "idefics", "cogvlm", "deepseek-vl", "olmocr",
];

function inlineLooksLikeVision(modelKey: string): boolean {
  if (!modelKey) return false;
  const lc = modelKey.toLowerCase();
  return VISION_MARKERS_INLINE.some((m) => lc.includes(m));
}

export async function listLoaded(): Promise<LoadedModelInfo[]> {
  return withSdk(
    async (client) => {
      const models = await client.llm.listLoaded();
      const infos: LoadedModelInfo[] = [];
      for (const handle of models) {
        const info = await handle.getModelInfo();
        const modelKey = info.modelKey;
        infos.push({
          identifier: info.identifier,
          modelKey,
          contextLength: info.contextLength,
          quantization: info.quantization ? String(info.quantization) : undefined,
          vision: inlineLooksLikeVision(modelKey),
          trainedForToolUse: looksLikeToolUseModel(modelKey),
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

/* S2.1: in-flight dedup для getServerStatus(). Watchdog (lmstudio-watchdog.ts)
   опрашивает раз в 5s, параллельно UI Settings/Welcome Wizard может вызвать
   тот же ping. До дедупа на каждый вызов уходил отдельный WS-handshake
   к LM Studio — при недоступном сервере оба ловили reject и дважды
   звали dropClient() (идемпотентно, но всё равно лишняя нагрузка
   на event loop). Singleton Promise сворачивает это в один inflight
   запрос; новые вызовы за время полёта возвращают тот же результат. */
let inflightStatus: Promise<{ online: boolean; version?: string }> | null = null;

export async function getServerStatus(): Promise<{ online: boolean; version?: string }> {
  if (inflightStatus) return inflightStatus;
  inflightStatus = (async () => {
    try {
      const client = getClient();
      const v = await Promise.race([
        client.system.getLMStudioVersion(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error("LM Studio SDK timeout")), SDK_TIMEOUT_MS);
          t.unref();
        }),
      ]);
      return { online: true, version: v.version };
    } catch {
      dropClient();
      return { online: false };
    } finally {
      inflightStatus = null;
    }
  })();
  return inflightStatus;
}

/**
 * Async-вариант disposal: ОЖИДАЕТ полного закрытия SDK клиента
 * (websocket → http2 streams) с timeout. Используется в `before-quit`
 * чтобы LM Studio не держал соединение от мёртвого процесса.
 *
 * @param timeoutMs макс время ожидания закрытия (по умолчанию 1.5 сек —
 *                  быстрее force-exit timer = 4 сек в main.ts).
 * @returns true если closed gracefully, false по таймауту/ошибке.
 */
export async function disposeClientAsync(timeoutMs = 1_500): Promise<boolean> {
  if (!cachedClient) return true;
  const client = cachedClient;
  dropClient(); /* сразу убираем cache, чтобы новые getClient() не использовали старый */
  const dispose = client[Symbol.asyncDispose];
  if (!dispose) return true;
  try {
    await Promise.race([
      dispose.call(client),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`disposeClientAsync timeout ${timeoutMs}ms`)), timeoutMs).unref(),
      ),
    ]);
    return true;
  } catch (err) {
    console.error("[lmstudio-client/disposeClientAsync] Error (websocket may leak):", err);
    return false;
  }
}
