/**
 * Тонкий fetch-клиент для Qdrant REST с таймаутом и обязательным User-Agent.
 * Используется во всех IPC-доменах, не имеющих SDK-клиента (`@qdrant/js-client-rest`).
 *
 * Не имеет глобального состояния. Конфигурация — через ENV или per-call параметры.
 */

import { DEFAULT_QDRANT_URL } from "../endpoints/index.js";

/**
 * Live-binding URL export. Set initially from env (and updated by
 * `setQdrantUrl()` once preferences resolve at boot, and again on every
 * `preferences:set` if the user changes it in Settings). Consumers that
 * use ESM `import { QDRANT_URL } from ...` see the current value on
 * every read because ES module bindings are reactive.
 *
 * For paths where the URL has to be guaranteed-fresh (e.g. inside a
 * promise that survived a settings change), use the async `getQdrantUrl()`
 * from `../endpoints/index.js` directly.
 */
export let QDRANT_URL: string = process.env.QDRANT_URL || DEFAULT_QDRANT_URL;

/**
 * Update the QDRANT_URL live binding. Called by the preferences IPC
 * handler after a successful set/reset; also called once at boot from
 * main.ts after `getEndpoints()` resolves.
 */
export function setQdrantUrl(url: string): void {
  if (typeof url === "string" && url.length > 0) {
    QDRANT_URL = url.replace(/\/+$/, "");
  }
}

export const QDRANT_API_KEY = process.env.QDRANT_API_KEY || undefined;
export const QDRANT_TIMEOUT_MS = 8_000;
export const QDRANT_USER_AGENT = "Bibliary/2.2 (https://github.com/bibliary/bibliary)";

/** Размер страницы scroll-запросов (точек за один HTTP). */
export const SCROLL_PAGE_SIZE = 256;

export interface QdrantFetchOptions extends RequestInit {
  /** Override the global QDRANT_TIMEOUT_MS for this call. */
  timeoutMs?: number;
}

export async function fetchQdrantJson<T>(url: string, options?: QdrantFetchOptions): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? QDRANT_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(`qdrant timeout ${timeoutMs}ms`), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "User-Agent": QDRANT_USER_AGENT,
      ...(QDRANT_API_KEY ? { "api-key": QDRANT_API_KEY } : {}),
      ...(options?.headers as Record<string, string> | undefined),
    };
    const { timeoutMs: _ignored, ...rest } = options ?? {};
    const response = await fetch(url, { ...rest, headers, signal: ctl.signal });
    if (!response.ok) {
      throw new Error(`Qdrant HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Иt 8Г.3: shared helper для delete points-by-filter.
 *
 * Раньше каждый caller (scanner.ipc, dataset-v2 reject-accepted, future
 * reimport cleanup) собирал inline fetch-вызов с одинаковым телом. Helper
 * нормализует контракт: `must`-фильтр со списком пар (field, exactValue),
 * `wait=true` для синхронного применения (важно для re-imports — следующий
 * upsert не должен видеть старые точки).
 *
 * Returns: `{ status: "ok" | "acknowledged", operation_id?: number }` —
 * Qdrant API контракт.
 *
 * Если delete не нашёл точек — это OK (idempotency); ошибка только при
 * HTTP failure / 4xx-5xx response (через fetchQdrantJson).
 */
export async function deletePointsByFilter(
  collection: string,
  matchers: Array<{ field: string; value: string | number }>,
  options?: { timeoutMs?: number },
): Promise<{ status: string; operation_id?: number }> {
  const must = matchers.map(({ field, value }) => ({ key: field, match: { value } }));
  return fetchQdrantJson<{ status: string; operation_id?: number }>(
    `${QDRANT_URL}/collections/${collection}/points/delete?wait=true`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { must } }),
      timeoutMs: options?.timeoutMs ?? QDRANT_TIMEOUT_MS,
    },
  );
}
