/**
 * SDK route for LM Studio (`@lmstudio/sdk`).
 *
 * Реализует Mahakala-проверенный паттерн "Strangler Fig": SDK живёт рядом
 * с REST, выбирается флагом `transport` в публичном API (см. lms-client-rest.ts),
 * при ошибке автоматически откатывается на REST.
 *
 * Преимущество SDK: `client.llm.load()` принимает полный `LLMLoadModelConfig`
 * (gpu.ratio, keepModelInMemory, tryMmap, flashAttention, contextLength),
 * чего REST `/api/v1/models/load` не умеет.
 *
 * Извлечён из `lms-client.ts` (Phase 2.1, 2026-04-30).
 */

import * as telemetry from "../../resilience/telemetry.js";
import type { LMSLoadConfig } from "../role-load-config.js";
import type {
  OlympicsLogger,
  OlympicsLLMHandle,
  OlympicsLMStudioClient,
} from "./lms-client-types.js";

/** Cache of SDK model handles keyed by handle.identifier (= instanceId).
 *  Required for unload — SDK needs the full handle, not just an id string. */
const _sdkHandles = new Map<string, OlympicsLLMHandle>();

/**
 * Graceful dispose Olympics SDK singleton при shutdown приложения
 * (v0.11.14, 2026-05-05).
 *
 * Зомби-баг: до этого фикса `_cachedSdkClient` НИКОГДА не закрывался при quit.
 * `lms-client-sdk.ts` создаёт ОТДЕЛЬНЫЙ от основного `lmstudio-client.ts`
 * singleton. Основной закрывается через `disposeClientAsync()` в before-quit,
 * Olympics — нет. WebSocket к LM Studio оставался висеть от мёртвого процесса.
 *
 * Контракт:
 *   1. Все handles в `_sdkHandles` пытаются `unload()` — best-effort, не критично
 *      если LM Studio уже отключён.
 *   2. У клиента вызывается `Symbol.asyncDispose` (если поддерживается SDK) —
 *      это закрывает WebSocket / HTTP/2 streams.
 *   3. Кэш handles + клиент сбрасываются.
 *
 * Timeout: best-effort, чтобы не задерживать quit на >1с (force-exit = 4с).
 */
export async function disposeOlympicsSdkClientAsync(timeoutMs = 1_000): Promise<boolean> {
  const client = _cachedSdkClient;
  const handles = [..._sdkHandles.values()];
  /* Сбрасываем кэш сразу — новый getClient() создаст свежий клиент. */
  _sdkHandles.clear();
  _cachedSdkClient = null;
  if (!client && handles.length === 0) return true;

  const work = (async (): Promise<void> => {
    for (const h of handles) {
      try { await h.unload(); } catch { /* tolerate — LM Studio мог уже отключиться */ }
    }
    /* @lmstudio/sdk LMStudioClient реализует Symbol.asyncDispose, но контракт
       OlympicsLMStudioClient в типах его не объявляет (минимальный API surface). */
    const dispose = client ? (client as { [Symbol.asyncDispose]?: () => Promise<void> })[Symbol.asyncDispose] : undefined;
    if (dispose) {
      try { await dispose.call(client); } catch { /* tolerate — websocket мог уже умереть */ }
    }
  })();

  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`disposeOlympicsSdkClientAsync timeout ${timeoutMs}ms`)), timeoutMs).unref(),
      ),
    ]);
    return true;
  } catch (err) {
    console.error("[lms-client-sdk/disposeAsync] Error (websocket may leak):", err);
    return false;
  }
}

/** Test override — bypass real `@lmstudio/sdk` import. */
let _sdkClientOverride: OlympicsLMStudioClient | null = null;
export function _setOlympicsSdkClientForTests(client: OlympicsLMStudioClient | null): void {
  _sdkClientOverride = client;
  if (!client) {
    _sdkHandles.clear();
    _cachedSdkClient = null;
  }
}

let _cachedSdkClient: OlympicsLMStudioClient | null = null;

/**
 * Lazy-resolve SDK client. Real import is dynamic to avoid pulling
 * `@lmstudio/sdk` into modules that never use the SDK route (lower
 * cold-start cost, easier mocking in tests).
 */
async function _getSdkClient(lmsUrl: string): Promise<OlympicsLMStudioClient> {
  if (_sdkClientOverride) return _sdkClientOverride;
  if (_cachedSdkClient) return _cachedSdkClient;
  const sdk = (await import("@lmstudio/sdk")) as { LMStudioClient: new (opts?: { baseUrl?: string }) => OlympicsLMStudioClient };
  const wsUrl = lmsUrl.replace(/^http(s?):\/\//, "ws$1://");
  _cachedSdkClient = new sdk.LMStudioClient({ baseUrl: wsUrl });
  return _cachedSdkClient;
}

/**
 * Convert internal LMSLoadConfig → SDK LLMLoadModelConfig shape.
 * Skips undefined fields so SDK uses its own defaults.
 */
function _toSdkLoadConfig(cfg: LMSLoadConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof cfg.contextLength === "number") out.contextLength = cfg.contextLength;
  if (typeof cfg.flashAttention === "boolean") out.flashAttention = cfg.flashAttention;
  if (typeof cfg.keepModelInMemory === "boolean") out.keepModelInMemory = cfg.keepModelInMemory;
  if (typeof cfg.tryMmap === "boolean") out.tryMmap = cfg.tryMmap;
  if (cfg.gpu && typeof cfg.gpu.ratio === "number") out.gpu = { ratio: cfg.gpu.ratio };
  return out;
}

/**
 * Load a model via LM Studio SDK. Returns SDK handle.identifier as instanceId.
 *
 * Caller MUST unload via `lmsUnloadModelSDK(instanceId)` (or `lmsUnloadModel`
 * with transport="sdk") to release the handle and free VRAM.
 */
export async function lmsLoadModelSDK(
  lmsUrl: string,
  modelKey: string,
  log: OlympicsLogger,
  signal?: AbortSignal,
  loadConfig?: LMSLoadConfig,
): Promise<{ ok: true; instanceId: string; loadTimeMs: number } | { ok: false; reason: string }> {
  const t0 = Date.now();
  if (signal?.aborted) return { ok: false, reason: "aborted before SDK load" };
  const cfg: LMSLoadConfig = loadConfig ?? { contextLength: 2048, flashAttention: true };
  const sdkConfig = _toSdkLoadConfig(cfg);
  log("info", "loading model via SDK", { modelKey, sdkConfig });
  telemetry.logEvent({ type: "olympics.model_lifecycle", phase: "load_start", modelKey });
  try {
    const client = await _getSdkClient(lmsUrl);
    /* SDK `.load()` доменно блокирующий — race с external signal руками.
     * abort просто оставит handle висеть, но это лучше чем зависнуть
     * на 3 минуты VRAM-bound операции. */
    const handle = await Promise.race([
      client.llm.load(modelKey, { config: sdkConfig }),
      new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        const onAbort = (): void => reject(new Error("aborted during SDK load"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    const instanceId = handle.identifier;
    _sdkHandles.set(instanceId, handle);
    const loadTimeMs = Date.now() - t0;
    log("info", `SDK loaded in ${loadTimeMs}ms`, { modelKey, instanceId });
    telemetry.logEvent({ type: "olympics.model_lifecycle", phase: "load_ok", modelKey, instanceId, durationMs: loadTimeMs });
    return { ok: true, instanceId, loadTimeMs };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const loadTimeMs = Date.now() - t0;
    log("error", "SDK load failed", { modelKey, reason, loadTimeMs });
    telemetry.logEvent({ type: "olympics.model_lifecycle", phase: "load_fail", modelKey, durationMs: loadTimeMs, error: reason });
    return { ok: false, reason };
  }
}

/**
 * Unload via SDK handle. If handle isn't in cache (e.g. mixed REST+SDK
 * session) — falls through to client.llm.unload(identifier) which works
 * for SDK-loaded models keyed by identifier.
 */
export async function lmsUnloadModelSDK(
  lmsUrl: string,
  instanceId: string,
  log: OlympicsLogger,
): Promise<boolean> {
  const t0 = Date.now();
  try {
    const cached = _sdkHandles.get(instanceId);
    if (cached) {
      await cached.unload();
      _sdkHandles.delete(instanceId);
    } else {
      const client = await _getSdkClient(lmsUrl);
      await client.llm.unload(instanceId);
    }
    const durationMs = Date.now() - t0;
    log("info", `SDK unloaded in ${durationMs}ms`, { instanceId });
    telemetry.logEvent({ type: "olympics.model_lifecycle", phase: "unload_ok", modelKey: instanceId, instanceId, durationMs });
    return true;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log("warn", "SDK unload failed (best-effort)", { instanceId, reason });
    telemetry.logEvent({
      type: "olympics.model_lifecycle",
      phase: "unload_fail",
      modelKey: instanceId,
      instanceId,
      durationMs: Date.now() - t0,
      error: reason,
    });
    return false;
  }
}
