/**
 * Тонкий fetch-клиент для Chroma REST с таймаутом и обязательным User-Agent.
 * Используется во всех IPC-доменах. SDK `chromadb` намеренно не используется —
 * сохраняем HTTP-only паттерн как было с Qdrant (один источник истины,
 * один способ debug'а через curl).
 *
 * Не имеет глобального состояния. Конфигурация — через ENV или per-call параметры.
 */

import { DEFAULT_CHROMA_URL } from "../endpoints/index.js";

/**
 * Live-binding URL export. Set initially from env (and updated by
 * `setChromaUrl()` once preferences resolve at boot, and again on every
 * `preferences:set` if the user changes it in Settings). Consumers that
 * use ESM `import { CHROMA_URL } from ...` see the current value on
 * every read because ES module bindings are reactive.
 */
export let CHROMA_URL: string = process.env.CHROMA_URL || DEFAULT_CHROMA_URL;

/**
 * Update the CHROMA_URL live binding. Called by the preferences IPC handler
 * after a successful set/reset; also called once at boot from main.ts after
 * `getEndpoints()` resolves.
 */
export function setChromaUrl(url: string): void {
  if (typeof url === "string" && url.length > 0) {
    CHROMA_URL = url.replace(/\/+$/, "");
  }
}

/**
 * Auth header. Chroma OSS использует `X-Chroma-Token` (CIP-3 standard).
 * Опциональный — при пустом env пишется без auth (default chromadb run без auth).
 */
export const CHROMA_API_KEY = process.env.CHROMA_API_KEY || undefined;
export const CHROMA_TIMEOUT_MS = 8_000;
export const CHROMA_USER_AGENT = "Bibliary/3.0 (https://github.com/antsincgame/bibliary)";

/** Размер страницы scroll-запросов (точек за один HTTP). */
export const SCROLL_PAGE_SIZE = 256;

/**
 * Базовый префикс REST API Chroma — версия v1.
 * Документация: https://docs.trychroma.com/reference/python/client
 */
export const CHROMA_API_PREFIX = "/api/v1";

export interface ChromaFetchOptions extends RequestInit {
  /** Override the global CHROMA_TIMEOUT_MS for this call. */
  timeoutMs?: number;
}

/**
 * Низкоуровневый JSON-fetch к Chroma REST с timeout, User-Agent и optional auth.
 * Бросает Error при non-2xx ответе или timeout.
 */
export async function fetchChromaJson<T>(url: string, options?: ChromaFetchOptions): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? CHROMA_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(`chroma timeout ${timeoutMs}ms`), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "User-Agent": CHROMA_USER_AGENT,
      ...(CHROMA_API_KEY ? { "X-Chroma-Token": CHROMA_API_KEY } : {}),
      ...(options?.headers as Record<string, string> | undefined),
    };
    const { timeoutMs: _ignored, ...rest } = options ?? {};
    const response = await fetch(url, { ...rest, headers, signal: ctl.signal });
    if (!response.ok) {
      let detail = "";
      try {
        const text = await response.text();
        detail = text ? ` — ${text.slice(0, 200)}` : "";
      } catch { /* ignore body read errors */ }
      throw new Error(`Chroma HTTP ${response.status}: ${response.statusText}${detail}`);
    }
    /* DELETE может возвращать пустое тело — обрабатываем безопасно. */
    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      return undefined as unknown as T;
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Удобный билдер URL: `chromaUrl("/collections/abc/upsert")` → `${CHROMA_URL}/api/v1/collections/abc/upsert` */
export function chromaUrl(pathSuffix: string): string {
  const suffix = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
  return `${CHROMA_URL}${CHROMA_API_PREFIX}${suffix}`;
}
