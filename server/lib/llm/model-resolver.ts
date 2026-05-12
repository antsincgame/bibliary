import { getPreferences } from "../preferences/store.js";
import { getProvider } from "./registry.js";
import type { LLMProvider, LLMRole, ProviderId } from "./provider.js";

/**
 * Resolves a user's role assignment (`providerAssignments[role]`) into a
 * concrete provider instance + model identifier. Consumers (evaluator,
 * extractor, OCR, etc.) call `resolveForRole(userId, "crystallizer")`
 * instead of hardcoding LM Studio.
 *
 * Storage shape in user_preferences:
 *   providerAssignments: {
 *     crystallizer:  { provider: "anthropic", model: "claude-sonnet-4-6" },
 *     evaluator:     { provider: "openai",    model: "gpt-5-mini" },
 *     vision_meta:   { provider: "lmstudio",  model: "qwen2-vl-7b" },
 *     ...
 *   }
 *
 * Fallback: если роль не назначена — пробуем LM Studio. Если LM Studio
 * не online / модель не загружена — throw `ProviderNotAvailableError`
 * с понятным message для UI.
 */

export class ProviderNotAvailableError extends Error {
  constructor(message: string, public readonly role: LLMRole) {
    super(message);
    this.name = "ProviderNotAvailableError";
  }
}

export interface ResolvedProvider {
  provider: LLMProvider;
  providerId: ProviderId;
  model: string;
  /**
   * True если роль не назначена в user_preferences и мы упали на
   * LM Studio + first loaded model (silent fallback). UI должен
   * показать toast «Using LM Studio fallback — configure provider
   * in Settings → Providers» чтобы user понял почему ответы
   * приходят не от Claude/GPT когда он ожидал.
   */
  usingFallback: boolean;
}

export async function resolveForRole(
  userId: string,
  role: LLMRole,
): Promise<ResolvedProvider> {
  const prefs = await getPreferences(userId);
  const assignments =
    (prefs as Record<string, unknown>)["providerAssignments"] ?? {};
  const entry = (assignments as Record<string, { provider?: string; model?: string }>)[role];

  let providerId: ProviderId;
  let model: string;
  let usingFallback = false;
  if (entry && isProviderId(entry.provider) && typeof entry.model === "string" && entry.model) {
    providerId = entry.provider;
    model = entry.model;
  } else {
    providerId = "lmstudio";
    const fallback = await pickDefaultLmStudioModel();
    if (!fallback) {
      throw new ProviderNotAvailableError(
        `Role "${role}" not assigned and no LM Studio model loaded as fallback`,
        role,
      );
    }
    model = fallback;
    usingFallback = true;
  }

  try {
    const provider = await getProvider(userId, providerId);
    return { provider, providerId, model, usingFallback };
  } catch (err) {
    throw new ProviderNotAvailableError(
      `Provider "${providerId}" for role "${role}" unavailable: ${err instanceof Error ? err.message : String(err)}`,
      role,
    );
  }
}

function isProviderId(v: unknown): v is ProviderId {
  return v === "lmstudio" || v === "anthropic" || v === "openai";
}

async function pickDefaultLmStudioModel(): Promise<string | null> {
  try {
    const { listLoaded } = await import("./lmstudio-bridge.js");
    const loaded = await listLoaded();
    return loaded[0]?.modelKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Convenience wrapper: `withProvider(userId, role, async (p, model) => ...)`.
 * Используется в evaluator-queue / extractor-runner — caller получает
 * готовый provider instance и не повторяет boilerplate.
 */
export async function withProvider<T>(
  userId: string,
  role: LLMRole,
  fn: (
    provider: LLMProvider,
    model: string,
    providerId: ProviderId,
    usingFallback: boolean,
  ) => Promise<T>,
): Promise<T> {
  const { provider, providerId, model, usingFallback } = await resolveForRole(userId, role);
  return fn(provider, model, providerId, usingFallback);
}
