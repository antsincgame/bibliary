import Anthropic from "@anthropic-ai/sdk";

import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderModel,
} from "../provider.js";

/**
 * Anthropic Claude провайдер.
 *
 * Поддержка:
 *   - Messages API (без legacy completions).
 *   - Prompt caching (`cache_control: {type: "ephemeral"}`) на system
 *     prompt + первом user-block — критично для крупных контекстов
 *     (Bibliary crystallizer часто шлёт 30K+ tokens книги).
 *   - Vision (image blocks) через ChatAttachment kind="image" — adapter
 *     умеет их собирать, но server-side роли, которая их шлёт, пока нет.
 *   - Extended thinking для reasoning моделей (claude-4-*-thinking)
 *     — пока не передаётся явно, SDK выдаёт reasoning блоки в content.
 *
 * Кеш моделей: списка от Anthropic нет в SDK (нет /v1/models endpoint
 * на момент 2026-05). Возвращаем hardcoded список — обновляется при
 * выходе новых моделей. См. https://docs.anthropic.com/.../models.
 */

const KNOWN_MODELS: ProviderModel[] = [
  { modelId: "claude-opus-4-7", displayName: "Claude Opus 4.7", contextLength: 1_000_000, vision: true, toolUse: true },
  { modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextLength: 1_000_000, vision: true, toolUse: true },
  { modelId: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", contextLength: 200_000, vision: true, toolUse: true },
];

const VISION_MODEL_PREFIX = /^claude-(opus|sonnet|haiku)-[34]/i;

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Override default Anthropic endpoint (для LiteLLM proxy / self-hosted gateway). */
  baseURL?: string;
}

export function createAnthropicProvider(
  opts: AnthropicProviderOptions,
): LLMProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  return {
    id: "anthropic",

    async listAvailable() {
      /* SDK не отдаёт live model list — отдаём hardcoded. */
      return KNOWN_MODELS;
    },

    isVisionCapable(modelId) {
      const known = KNOWN_MODELS.find((m) => m.modelId === modelId);
      if (known) return known.vision === true;
      return VISION_MODEL_PREFIX.test(modelId);
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      /* Anthropic API не принимает role=system в messages — system идёт
       * отдельным top-level параметром. Фильтруем перед map чтобы тип
       * после filter был уже narrow. */
      const userAndAssistant = req.messages.filter(
        (m): m is { role: "user" | "assistant"; content: string; attachments?: import("../provider.js").ChatAttachment[] } =>
          m.role !== "system",
      );
      const messages = userAndAssistant.map((m) => ({
        role: m.role,
        content: buildContentBlocks(m, req.promptCache === true),
      }));

      const systemBlocks =
        req.system && req.system.length > 0
          ? [
              req.promptCache
                ? {
                    type: "text" as const,
                    text: req.system,
                    cache_control: { type: "ephemeral" as const },
                  }
                : { type: "text" as const, text: req.system },
            ]
          : undefined;

      const params: Parameters<typeof client.messages.create>[0] = {
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        messages: messages as unknown as Parameters<typeof client.messages.create>[0]["messages"],
        ...(systemBlocks ? { system: systemBlocks } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      };

      /* SDK returns `Message | Stream<...>` union — мы используем
       * non-streaming режим (default), cast'им к Message чтобы TS не
       * прохожить union на каждом property access. */
      const response = (await client.messages.create(params, {
        ...(req.signal ? { signal: req.signal } : {}),
      })) as Anthropic.Message;

      let text = "";
      let reasoning: string | undefined;
      for (const block of response.content) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "thinking") {
          const thinkingBlock = block as { type: "thinking"; thinking?: string };
          if (typeof thinkingBlock.thinking === "string") {
            reasoning = (reasoning ?? "") + thinkingBlock.thinking;
          }
        }
      }

      return {
        text,
        ...(reasoning ? { reasoning } : {}),
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? undefined,
          cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? undefined,
        },
        ...(response.stop_reason ? { finishReason: response.stop_reason } : {}),
        raw: response,
      };
    },
  };
}

function buildContentBlocks(
  message: { content: string; attachments?: import("../provider.js").ChatAttachment[] },
  cacheLast: boolean,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (message.content) {
    const block: Record<string, unknown> = { type: "text", text: message.content };
    if (cacheLast) block["cache_control"] = { type: "ephemeral" };
    blocks.push(block);
  }
  if (message.attachments?.length) {
    for (const a of message.attachments) {
      if (a.kind === "image") {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: a.mime,
            data: a.base64,
          },
        });
      }
    }
  }
  return blocks;
}
