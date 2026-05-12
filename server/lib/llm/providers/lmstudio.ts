import {
  getServerStatus,
  listDownloaded,
  listLoaded,
  loadModel,
  unloadModel,
} from "../lmstudio-bridge.js";
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderModel,
} from "../provider.js";
import { loadConfig } from "../../../config.js";

/**
 * LM Studio adapter поверх существующего lmstudio-bridge.ts.
 *
 * Особенности vs cloud providers:
 *   - Stateful: модели надо load() перед chat() — listLoaded() показывает
 *     активные в VRAM.
 *   - URL читается из admin config (BIBLIARY_LM_STUDIO_URL env / prefs.
 *     LM_STUDIO_URL), один на весь backend. Per-user override не имеет
 *     смысла — это локальный сервис админа.
 *   - chat() здесь использует OpenAI-compatible endpoint LM Studio,
 *     потому что @lmstudio/sdk client.llm.respond требует loaded model
 *     handle (overhead overload пула). Прямой fetch на /v1/chat/completions
 *     проще и совместим с любой OpenAI-shape LLM.
 *   - promptCache игнорируется (locally нет remote cost saving).
 */

const VISION_PATTERN = /(vision|vl|qwen2-vl|llava|moondream)/i;

export function createLMStudioProvider(): LLMProvider {
  return {
    id: "lmstudio",

    async listAvailable() {
      const list = await listDownloaded();
      return list.map(
        (m): ProviderModel => ({
          modelId: m.modelKey,
          ...(m.displayName ? { displayName: m.displayName } : {}),
          vision: VISION_PATTERN.test(m.modelKey) || VISION_PATTERN.test(m.displayName ?? ""),
          meta: {
            ...(m.format ? { format: m.format } : {}),
            ...(m.paramsString ? { paramsString: m.paramsString } : {}),
            ...(m.sizeBytes ? { sizeBytes: m.sizeBytes } : {}),
          },
        }),
      );
    },

    async listLoaded() {
      const list = await listLoaded();
      return list.map(
        (m): ProviderModel => ({
          modelId: m.modelKey,
          ...(m.contextLength !== undefined ? { contextLength: m.contextLength } : {}),
          vision:
            m.vision === true ||
            VISION_PATTERN.test(m.modelKey) ||
            VISION_PATTERN.test(m.identifier),
          toolUse: m.trainedForToolUse === true,
          meta: {
            identifier: m.identifier,
            ...(m.quantization ? { quantization: m.quantization } : {}),
          },
        }),
      );
    },

    async load(modelKey, opts) {
      await loadModel(modelKey, opts as Parameters<typeof loadModel>[1]);
    },

    async unload(identifier) {
      await unloadModel(identifier);
    },

    isVisionCapable(modelId) {
      return VISION_PATTERN.test(modelId);
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const cfg = loadConfig();
      const base = cfg.LM_STUDIO_URL.replace(/\/$/, "");
      const url = `${base}/v1/chat/completions`;

      const messages: Array<Record<string, unknown>> = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      for (const m of req.messages) {
        if (m.attachments && m.attachments.length > 0) {
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
          messages.push({ role: m.role, content: parts });
        } else {
          messages.push({ role: m.role, content: m.content });
        }
      }

      const body: Record<string, unknown> = {
        model: req.model,
        messages,
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.responseFormat === "json_object"
          ? { response_format: { type: "json_object" } }
          : {}),
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`lmstudio.chat: HTTP ${res.status} ${text.slice(0, 240)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      const finishReason = data.choices?.[0]?.finish_reason;
      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
        },
        ...(finishReason ? { finishReason } : {}),
        raw: data,
      };
    },
  };
}

/** Convenience — verbose health check for admin diagnostics. */
export async function lmStudioStatus(): Promise<ReturnType<typeof getServerStatus>> {
  return getServerStatus();
}
