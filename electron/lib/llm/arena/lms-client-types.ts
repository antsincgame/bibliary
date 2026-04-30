/**
 * Common types and logger helper for LM Studio client.
 *
 * Извлечён из `lms-client.ts` в рамках декомпозиции (Phase 2.1, 2026-04-30).
 * Импорт через barrel `lms-client.ts` или напрямую — оба пути валидны.
 */

export const DEFAULT_LMS_URL = "http://localhost:1234";
export type LmsTransport = "rest" | "sdk";

/* ─── Logger ──────────────────────────────────────────────────────────── */

export type OlympicsLogLevel = "info" | "warn" | "error" | "debug";
export type OlympicsLogger = (
  level: OlympicsLogLevel,
  msg: string,
  ctx?: Record<string, unknown>,
) => void;

/** Event payload shape used by `makeLogger` to dispatch UI logs. Mirrors a
 *  minimal subset of `OlympicsEvent` so this module stays UI-agnostic. */
export interface OlympicsLogEventEmitter {
  (e: { type: "olympics.log"; level: OlympicsLogLevel; message: string; ctx?: Record<string, unknown> }): void;
}

export function makeLogger(onLog?: OlympicsLogEventEmitter): OlympicsLogger {
  return (level, msg, ctx) => {
    const prefix = `[olympics ${new Date().toISOString()}] ${level.toUpperCase()}`;
    const ctxStr = ctx && Object.keys(ctx).length > 0 ? " " + JSON.stringify(ctx) : "";
    const line = `${prefix} ${msg}${ctxStr}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    onLog?.({ type: "olympics.log", level, message: msg, ctx });
  };
}

/* ─── Catalog ─────────────────────────────────────────────────────────── */

export interface LmsModelInfo {
  key: string;
  type: "llm" | "embedding";
  publisher: string;
  displayName: string;
  architecture: string;
  quantization: { name: string; bits_per_weight: number };
  sizeBytes: number;
  paramsString: string | null;
  loadedInstances: Array<{ id: string; config: Record<string, unknown> }>;
  maxContextLength: number;
  format: string;
  capabilities: {
    vision: boolean;
    trained_for_tool_use: boolean;
    reasoning?: { allowed_options: string[]; default: string };
  };
  description: string | null;
}

/* ─── Chat ───────────────────────────────────────────────────────────── */

export interface ChatResp {
  content: string;
  durationMs: number;
  totalTokens: number;
  /** prompt токены (LM Studio v1.x возвращает usage.prompt_tokens). */
  promptTokens?: number;
  /** completion токены (LM Studio v1.x возвращает usage.completion_tokens). */
  completionTokens?: number;
  ok: boolean;
  error?: string;
}

/* ─── SDK contract ───────────────────────────────────────────────────── */

/**
 * Минимальный TypeScript-контракт LMStudioClient — только методы которые
 * реально использует Olympics. Это позволяет тестам подменить клиент
 * mock-объектом без `any`, и не зависеть от полного SDK типа в API.
 */
export interface OlympicsLLMHandle {
  identifier: string;
  unload(): Promise<void>;
}
export interface OlympicsLLMNamespace {
  load(modelKey: string, options?: { config?: Record<string, unknown>; ttl?: number; identifier?: string }): Promise<OlympicsLLMHandle>;
  unload(identifier: string): Promise<void>;
}
export interface OlympicsLMStudioClient {
  llm: OlympicsLLMNamespace;
}
