/**
 * Unified LLM provider interface. Каждый concrete провайдер
 * (lmstudio / anthropic / openai) реализует подмножество — required
 * methods это `id`, `chat`, `listAvailable`; vision / embeddings /
 * model управление — опционально (capability detection через
 * наличие метода).
 */

export type ProviderId = "lmstudio" | "anthropic" | "openai";

export type LLMRole =
  | "crystallizer"
  | "evaluator"
  | "vision_meta"
  | "vision_ocr"
  | "vision_illustration"
  | "layout_assistant"
  | "ukrainian_specialist"
  | "lang_detector"
  | "translator";

export interface ProviderModel {
  /** Provider-scoped identifier (например "claude-sonnet-4-6" или path для LM Studio). */
  modelId: string;
  /** Human display name (если провайдер отдаёт). */
  displayName?: string;
  /** Maximum context tokens. */
  contextLength?: number;
  /** Provider claims vision capability. */
  vision?: boolean;
  /** Provider claims tool-use capability. */
  toolUse?: boolean;
  /** Free-form provider-specific metadata. */
  meta?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /**
   * Plain text content. Provider-specific structured content (tool calls,
   * vision blocks) ходит через `attachments` чтобы не плодить union
   * type — каждый adapter сам понимает формат.
   */
  content: string;
  attachments?: ChatAttachment[];
}

export type ChatAttachment =
  | { kind: "image"; mime: string; base64: string }
  | { kind: "tool_result"; toolUseId: string; content: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Tell провайдер что ответ должен быть валидным JSON (если поддерживается). */
  responseFormat?: "text" | "json_object";
  /**
   * Hint провайдеру использовать prompt caching для long context.
   * Anthropic: cache_control на system + первом user-message.
   * OpenAI: каноническая ordering (no special API но prompts >1024 tokens
   * автоматом cache'аются с 2024).
   * LM Studio: no-op (local, нет remote cost saving).
   */
  promptCache?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  /** Reasoning tokens (если модель thinking-capable и эти токены отдельны). */
  reasoning?: string;
  /** Raw usage stats — input/output tokens, cache hit count. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  /** Финиш-причина — "stop", "max_tokens", "tool_use", "content_filter". */
  finishReason?: string;
  /** Provider-specific raw response (для отладки). */
  raw?: unknown;
}

export interface LLMProvider {
  readonly id: ProviderId;

  /** Models reachable from this provider for the current credentials. */
  listAvailable(): Promise<ProviderModel[]>;

  /** Loaded models — applicable только для LM Studio (там модели надо load/unload). */
  listLoaded?(): Promise<ProviderModel[]>;
  load?(modelId: string, opts?: Record<string, unknown>): Promise<void>;
  unload?(modelId: string): Promise<void>;

  /** Heuristic: модель support vision? Использует metadata из listAvailable. */
  isVisionCapable(modelId: string): boolean;

  chat(req: ChatRequest): Promise<ChatResponse>;

  /** Опционально: embedding API (Anthropic не отдаёт, OpenAI отдаёт). */
  embed?(text: string, model?: string): Promise<Float32Array>;
}
