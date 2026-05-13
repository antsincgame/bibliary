import { decryptSecret } from "../crypto/secrets.js";
import { getPreferences } from "../preferences/store.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createLMStudioProvider } from "./providers/lmstudio.js";
import { createOpenAIProvider } from "./providers/openai.js";
import type { LLMProvider, ProviderId } from "./provider.js";

/**
 * Per-user provider factory. Anthropic / OpenAI читают encrypted API
 * keys из `user_preferences.providerSecretsEncrypted`. LM Studio
 * глобальный — admin URL, без per-user.
 *
 * Cache: один LLMProvider per (userId, providerId). Anthropic/OpenAI SDK
 * хранят cached fetch agent — переиспользовать дешевле чем пересоздавать
 * на каждый chat() вызов. LM Studio singleton.
 *
 * @example
 *   const anthropic = await getProvider(userId, "anthropic");
 *   await anthropic.chat({ model: "claude-sonnet-4-6", messages: [...] });
 */

interface CachedProvider {
  userId: string;
  providerId: ProviderId;
  instance: LLMProvider;
}

const cache = new Map<string, CachedProvider>();

function cacheKey(userId: string, providerId: ProviderId): string {
  return `${userId}::${providerId}`;
}

export function _clearProviderCacheForTesting(): void {
  cache.clear();
}

/**
 * Returns the configured provider instance for user. Throws if the key
 * is missing (для cloud провайдеров) — caller должен предложить юзеру
 * настроить ключи через UI.
 */
export async function getProvider(
  userId: string,
  providerId: ProviderId,
): Promise<LLMProvider> {
  const key = cacheKey(userId, providerId);
  const cached = cache.get(key);
  if (cached) return cached.instance;

  let instance: LLMProvider;
  if (providerId === "lmstudio") {
    /* LM Studio: единый instance на backend, но cache держим в той же
     * Map по тому же ключу — упрощает invalidation. */
    instance = createLMStudioProvider();
  } else {
    const apiKey = await loadSecret(userId, providerId);
    if (!apiKey) {
      throw new Error(
        `[llm/registry] provider "${providerId}" not configured for user — set API key via settings`,
      );
    }
    if (providerId === "anthropic") {
      instance = createAnthropicProvider({ apiKey });
    } else if (providerId === "openai") {
      instance = createOpenAIProvider({ apiKey });
    } else {
      throw new Error(`[llm/registry] unknown providerId: ${providerId as string}`);
    }
  }

  cache.set(key, { userId, providerId, instance });
  return instance;
}

/**
 * Inspect which providers user has configured (без раскрытия ключей).
 * Используется UI для отображения «Anthropic: configured / OpenAI: not set».
 */
export async function listConfiguredProviders(
  userId: string,
): Promise<Array<{ providerId: ProviderId; configured: boolean; hint?: string }>> {
  const prefs = await getPreferences(userId);
  const secretsRaw =
    (prefs as Record<string, unknown>)["providerSecretsEncrypted"] ?? {};
  const secrets = secretsRaw as Record<string, { hint?: string; encrypted?: string }>;
  return (
    ["lmstudio", "anthropic", "openai"] as ProviderId[]
  ).map((id) => {
    if (id === "lmstudio") return { providerId: id, configured: true };
    const entry = secrets[id];
    return {
      providerId: id,
      configured: typeof entry?.encrypted === "string",
      ...(entry?.hint ? { hint: entry.hint } : {}),
    };
  });
}

async function loadSecret(
  userId: string,
  providerId: ProviderId,
): Promise<string | null> {
  const prefs = await getPreferences(userId);
  const secretsRaw =
    (prefs as Record<string, unknown>)["providerSecretsEncrypted"] ?? {};
  const secrets = secretsRaw as Record<string, { encrypted?: string }>;
  const entry = secrets[providerId];
  if (!entry?.encrypted) return null;
  return decryptSecret(entry.encrypted);
}

/** Invalidate cache when user updates secrets / changes config. */
export function invalidateProvider(userId: string, providerId?: ProviderId): void {
  if (providerId) {
    cache.delete(cacheKey(userId, providerId));
    return;
  }
  for (const k of cache.keys()) {
    if (k.startsWith(`${userId}::`)) cache.delete(k);
  }
}
