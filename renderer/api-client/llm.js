import { http } from "./http.js";

/**
 * LLM provider configuration surface.
 *
 * Renderer UI Settings → Providers использует это для:
 *   1. показать список configured ({providerId, configured, hint})
 *   2. сохранить новый key (PUT /secret) с inline test
 *   3. очистить key (DELETE /secret)
 *   4. test connection (POST /test) → {ok, modelsCount, sampleModels}
 *   5. listModels(provider) для dropdown'а assignments
 *   6. read/write assignments (role → {provider, model})
 *
 * Keys никогда не возвращаются — backend хранит encrypted, UI получает
 * только hint вида "sk-abc...c7d8".
 */

/** @typedef {"lmstudio" | "anthropic" | "openai"} ProviderId */

export const llm = {
  /** @returns {Promise<Array<{providerId: ProviderId, configured: boolean, hint?: string}>>} */
  listProviders: () => http.get("/api/llm/providers"),

  /**
   * @param {ProviderId} providerId
   * @param {string} apiKey
   * @returns {Promise<{ok: true, providerId: ProviderId, hint: string}>}
   */
  setSecret: (providerId, apiKey) =>
    http.put(`/api/llm/providers/${encodeURIComponent(providerId)}/secret`, {
      json: { apiKey },
    }),

  /** @param {ProviderId} providerId */
  clearSecret: (providerId) =>
    http.delete(`/api/llm/providers/${encodeURIComponent(providerId)}/secret`),

  /**
   * Live ping — backend пытается listAvailable() с текущим API key.
   * Возвращает ok=false с error message если не получилось (не throws).
   *
   * @param {ProviderId} providerId
   * @returns {Promise<{ok: boolean, providerId: ProviderId, modelsCount?: number, sampleModels?: string[], error?: string}>}
   */
  test: (providerId) =>
    http.post(`/api/llm/providers/${encodeURIComponent(providerId)}/test`),

  /**
   * @param {ProviderId} providerId
   * @returns {Promise<Array<{modelId: string, displayName?: string, contextLength?: number, vision?: boolean}>>}
   */
  listModels: (providerId) =>
    http.get(`/api/llm/providers/${encodeURIComponent(providerId)}/models`),

  /** @returns {Promise<Record<string, {provider: ProviderId, model: string}>>} */
  getAssignments: () => http.get("/api/llm/assignments"),

  /**
   * @param {Record<string, {provider: ProviderId, model: string}>} assignments
   */
  setAssignments: (assignments) =>
    http.put("/api/llm/assignments", { json: { assignments } }),
};
