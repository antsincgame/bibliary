/**
 * Pure-логика IPC хендлеров lmstudio.ipc.ts (extracted 2026-05-10).
 *
 * Только payload validators. ModelPool / SDK / logModelAction остаются
 * inline в registerLmstudioIpc — DI-рефакторинг этих singleton'ов
 * требует более широких изменений, и сами хендлеры тонкие («передай
 * args в pool и верни handle»). Здесь — защита IPC поверхности от bad
 * payload и pre-flight sanitization для probe-url (вызывается
 * onboarding wizard'ом, должен быть устойчив к плохому input'у).
 */

/* ─── lmstudio:probe-url ──────────────────────────────────────────── */

export interface ProbeUrlPayload {
  url: string;
  timeoutMs?: number;
  ipv4Fallback?: boolean;
}

/**
 * Sanitize probe-url args. Возвращает безопасные значения для передачи
 * в probeLmStudioUrl — никогда не throw'ает (onboarding wizard вызывает
 * это с любым input'ом от пользователя).
 *
 *   - url: non-string → "" (probeLmStudioUrl само вернёт ошибку для "")
 *   - timeoutMs: positive integer (ms) или undefined
 *   - ipv4Fallback: boolean или undefined
 */
export function sanitizeProbeUrlArgs(
  url: unknown,
  opts: unknown,
): ProbeUrlPayload {
  const safeUrl = typeof url === "string" ? url : "";
  const safeOpts = (opts && typeof opts === "object") ? (opts as Record<string, unknown>) : {};
  const out: ProbeUrlPayload = { url: safeUrl };
  if (
    typeof safeOpts.timeoutMs === "number" &&
    Number.isInteger(safeOpts.timeoutMs) &&
    safeOpts.timeoutMs > 0
  ) {
    out.timeoutMs = safeOpts.timeoutMs;
  }
  if (typeof safeOpts.ipv4Fallback === "boolean") {
    out.ipv4Fallback = safeOpts.ipv4Fallback;
  }
  return out;
}

/* ─── lmstudio:load ───────────────────────────────────────────────── */

export interface LoadModelArgs {
  modelKey: string;
  contextLength?: number;
  ttlSec?: number;
  gpuOffload?: "max" | number;
}

export interface LoadModelValidation {
  ok: boolean;
  data?: LoadModelArgs;
  reason?: string;
}

/**
 * Validate `lmstudio:load` payload. modelKey обязателен (non-empty string).
 * Опции — sanitized: only valid positive integers / specific enum values.
 *
 *   - contextLength: positive integer (tokens) или undefined
 *   - ttlSec: positive integer (seconds) или undefined
 *   - gpuOffload: "max" литерал или positive integer (layers count)
 */
export function validateLoadModelArgs(modelKey: unknown, opts: unknown): LoadModelValidation {
  if (typeof modelKey !== "string" || modelKey.length === 0) {
    return { ok: false, reason: "modelKey required" };
  }
  const data: LoadModelArgs = { modelKey };
  const safeOpts = (opts && typeof opts === "object") ? (opts as Record<string, unknown>) : {};

  if (
    typeof safeOpts.contextLength === "number" &&
    Number.isInteger(safeOpts.contextLength) &&
    safeOpts.contextLength > 0
  ) {
    data.contextLength = safeOpts.contextLength;
  }
  if (
    typeof safeOpts.ttlSec === "number" &&
    Number.isInteger(safeOpts.ttlSec) &&
    safeOpts.ttlSec > 0
  ) {
    data.ttlSec = safeOpts.ttlSec;
  }
  if (safeOpts.gpuOffload === "max") {
    data.gpuOffload = "max";
  } else if (
    typeof safeOpts.gpuOffload === "number" &&
    Number.isInteger(safeOpts.gpuOffload) &&
    safeOpts.gpuOffload >= 0
  ) {
    data.gpuOffload = safeOpts.gpuOffload;
  }
  return { ok: true, data };
}

/* ─── lmstudio:unload ─────────────────────────────────────────────── */

/**
 * Validate unload identifier. Возвращает null если invalid — caller
 * просто early-return (нет такой загруженной модели).
 */
export function validateUnloadIdentifier(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  return input;
}

/* ─── lmstudio:get-actions-log ────────────────────────────────────── */

/**
 * Validate maxLines query param. UI может прислать число или ничего.
 * Принимаем integer ≥1, иначе используем дефолт.
 */
export function sanitizeMaxLines(input: unknown, defaultValue: number): number {
  if (typeof input !== "number") return defaultValue;
  if (!Number.isInteger(input)) return defaultValue;
  if (input < 1) return defaultValue;
  return input;
}
