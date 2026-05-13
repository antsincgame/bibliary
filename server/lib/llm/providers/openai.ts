import OpenAI from "openai";

import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderModel,
} from "../provider.js";

/**
 * OpenAI ChatGPT провайдер.
 *
 * Возможности:
 *   - chat.completions с JSON mode (`response_format: { type: "json_object" }`)
 *   - Vision через image_url content blocks (gpt-4o*, gpt-5*)
 *   - Embeddings через отдельный API (text-embedding-3-small/large)
 *   - Prompt caching: 2024+ моделей кешируют автоматом prompts >1024 tok
 *     (без API hint). Маркер `promptCache` в нашем интерфейсе — no-op
 *     для OpenAI, но сохраняем флаг чтобы провайдеры были взаимозаменяемы.
 *
 * Список моделей грабится через `client.models.list()` — у OpenAI это
 * рабочий endpoint, отдаёт все доступные моделей с метаданными.
 */

const VISION_MODELS = new Set<string>([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4o-2024-08-06",
  "gpt-4-vision-preview",
  "gpt-5",
  "gpt-5-mini",
]);

const VISION_MODEL_PATTERN = /(gpt-4o|gpt-5|vision)/i;

export interface OpenAIProviderOptions {
  apiKey: string;
  /** Override base URL (для Azure OpenAI, LiteLLM gateway, local proxy). */
  baseURL?: string;
  /** OpenAI org id (если key привязан к нескольким org). */
  organization?: string;
}

export function createOpenAIProvider(
  opts: OpenAIProviderOptions,
): LLMProvider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.organization ? { organization: opts.organization } : {}),
  });

  return {
    id: "openai",

    async listAvailable() {
      const list = await client.models.list();
      const seen = new Set<string>();
      const result: ProviderModel[] = [];
      for await (const m of list) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        result.push({
          modelId: m.id,
          vision: VISION_MODELS.has(m.id) || VISION_MODEL_PATTERN.test(m.id),
        });
      }
      return result;
    },

    isVisionCapable(modelId) {
      return VISION_MODELS.has(modelId) || VISION_MODEL_PATTERN.test(modelId);
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const messages = buildMessages(req);
      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: req.model,
        messages: messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.responseFormat === "json_object"
          ? { response_format: { type: "json_object" as const } }
          : {}),
      };

      const response = (await client.chat.completions.create(params, {
        ...(req.signal ? { signal: req.signal } : {}),
      })) as OpenAI.Chat.Completions.ChatCompletion;

      const choice = response.choices[0];
      const text = choice?.message?.content ?? "";

      return {
        text,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          cacheReadInputTokens: response.usage?.prompt_tokens_details?.cached_tokens,
        },
        ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
        raw: response,
      };
    },

    async embed(text, model = "text-embedding-3-small") {
      const response = await client.embeddings.create({
        model,
        input: text,
      });
      const vec = response.data[0]?.embedding;
      if (!vec) throw new Error("openai.embed: empty embedding in response");
      return new Float32Array(vec);
    },
  };
}

function buildMessages(req: ChatRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.attachments && m.attachments.length > 0) {
      /** @type {Array<Record<string, unknown>>} */
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const a of m.attachments) {
        if (a.kind === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${a.mime};base64,${a.base64}` },
          });
        }
      }
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
