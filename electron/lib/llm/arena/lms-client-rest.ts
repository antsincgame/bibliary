/**
 * REST API for LM Studio (`/api/v1/...` and `/v1/chat/completions`).
 *
 * Простой transport, mock-ируется через `globalThis.fetch`. Минус: REST
 * `/load` принимает ТОЛЬКО {model, context_length, flash_attention,
 * echo_load_config}. Поля gpu/keepModelInMemory/tryMmap проигнорируются
 * (а в старых LM Studio вернут HTTP 400 — защищено regression-тестом).
 *
 * `lmsLoadModel`/`lmsUnloadModel` принимают `transport: "rest" | "sdk"` и
 * при `"sdk"` делегируют в `lms-client-sdk.ts`. При любой ошибке SDK —
 * runtime fallback на REST (Mahakala-страховка).
 *
 * Извлечён из `lms-client.ts` (Phase 2.1, 2026-04-30).
 */

import * as telemetry from "../../resilience/telemetry.js";
import type { LMSLoadConfig } from "../role-load-config.js";
import {
  DEFAULT_LMS_URL,
  type LmsTransport,
  type OlympicsLogger,
  type LmsModelInfo,
  type ChatResp,
} from "./lms-client-types.js";
import { lmsLoadModelSDK, lmsUnloadModelSDK } from "./lms-client-sdk.js";

/* ─── Catalog ─────────────────────────────────────────────────────────── */

/**
 * Fetch full model catalog via LM Studio v1 native API.
 * Falls back to old OpenAI-compat `/v1/models` if v1 unavailable.
 */
export async function lmsListModelsV1(lmsUrl: string = DEFAULT_LMS_URL): Promise<LmsModelInfo[]> {
  try {
    const r = await fetch(`${lmsUrl}/api/v1/models`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const data = (await r.json()) as { models: Array<Record<string, unknown>> };
      if (Array.isArray(data.models)) {
        return data.models
          .filter((m) => m.type === "llm")
          .map((m) => ({
            key: String(m.key ?? m.id ?? ""),
            type: "llm" as const,
            publisher: String(m.publisher ?? ""),
            displayName: String(m.display_name ?? m.key ?? ""),
            architecture: String(m.architecture ?? ""),
            quantization: (m.quantization as LmsModelInfo["quantization"]) ?? { name: "unknown", bits_per_weight: 4 },
            sizeBytes: Number(m.size_bytes ?? 0),
            paramsString: (m.params_string as string) ?? null,
            loadedInstances: Array.isArray(m.loaded_instances) ? (m.loaded_instances as LmsModelInfo["loadedInstances"]) : [],
            maxContextLength: Number(m.max_context_length ?? 0),
            format: String(m.format ?? ""),
            capabilities: {
              vision: !!(m.capabilities as Record<string, unknown>)?.vision,
              trained_for_tool_use: !!(m.capabilities as Record<string, unknown>)?.trained_for_tool_use,
              reasoning: (m.capabilities as Record<string, unknown>)?.reasoning as LmsModelInfo["capabilities"]["reasoning"],
            },
            description: (m.description as string) ?? null,
          }));
      }
    }
  } catch { /* v1 API unavailable — fallback below */ }

  /* Fallback: old OpenAI-compat endpoint → minimal LmsModelInfo. */
  const r = await fetch(`${lmsUrl}/v1/models`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`LM Studio offline (${lmsUrl}): HTTP ${r.status}`);
  const data = (await r.json()) as { data: Array<{ id: string }> };
  return data.data
    .filter((m) => !/embed/i.test(m.id))
    .map((m) => ({
      key: m.id,
      type: "llm" as const,
      publisher: "",
      displayName: m.id,
      architecture: "",
      quantization: { name: "unknown", bits_per_weight: 4 },
      sizeBytes: 0,
      paramsString: null,
      loadedInstances: [],
      maxContextLength: 0,
      format: "",
      capabilities: { vision: false, trained_for_tool_use: false },
      description: null,
    }));
}

/** Backward-compat wrapper for code that only needs model keys. */
export async function lmsListAvailableModels(lmsUrl: string = DEFAULT_LMS_URL): Promise<string[]> {
  const models = await lmsListModelsV1(lmsUrl);
  return models.map((m) => m.key);
}

/* ─── Lifecycle ──────────────────────────────────────────────────────── */

/**
 * Wait until LM Studio responds to a tiny health check. After load LM
 * Studio могут несколько секунд готовить кэш — без ping-а первый chat
 * получает spurious timeout.
 */
export async function lmsWaitForReady(
  lmsUrl: string,
  modelKey: string,
  log: OlympicsLogger,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<boolean> {
  const t0 = Date.now();
  let attempt = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (signal?.aborted) return false;
    attempt++;
    try {
      const r = await fetch(`${lmsUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelKey,
          messages: [{ role: "user", content: "ok" }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (r.ok) {
        log("debug", `model ready after ${Date.now() - t0}ms (attempt ${attempt})`, { modelKey });
        return true;
      }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 600));
  }
  log("warn", `model ready timeout after ${timeoutMs}ms`, { modelKey, attempts: attempt });
  return false;
}

/**
 * Load a model into LM Studio. Returns instance_id on success, null on failure.
 *
 * CRITICAL: caller MUST unload via lmsUnloadModel after use, otherwise
 * VRAM accumulates until BSOD.
 *
 * `transport`:
 *   - "rest" (default) — POST `/api/v1/models/load`. Простой, mock-able через
 *      `globalThis.fetch`. Игнорирует gpu/keepModelInMemory/tryMmap из cfg.
 *   - "sdk" — `client.llm.load(modelKey, { config })` через `@lmstudio/sdk`.
 *      Передаёт ВЕСЬ конфиг. При любой ошибке делает runtime-fallback на REST
 *      с предупреждением в лог (Mahakala-страховка).
 */
export async function lmsLoadModel(
  lmsUrl: string,
  modelKey: string,
  log: OlympicsLogger,
  signal?: AbortSignal,
  loadConfig?: LMSLoadConfig,
  transport: LmsTransport = "rest",
): Promise<{ ok: true; instanceId: string; loadTimeMs: number; transport: LmsTransport } | { ok: false; reason: string }> {
  if (transport === "sdk") {
    const sdkResult = await lmsLoadModelSDK(lmsUrl, modelKey, log, signal, loadConfig);
    if (sdkResult.ok) return { ...sdkResult, transport: "sdk" };
    log("warn", "SDK load failed — falling back to REST", { modelKey, sdkReason: sdkResult.reason });
    /* fall through to REST */
  }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 180_000);
  const onAbort = (): void => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  /* Default = legacy 2048/FA=true (backward-compat). */
  const cfg: LMSLoadConfig = loadConfig ?? { contextLength: 2048, flashAttention: true };
  const ctxLen = cfg.contextLength ?? 2048;
  const fa = cfg.flashAttention ?? true;
  log("info", "loading model", {
    modelKey,
    contextLength: ctxLen,
    flashAttention: fa,
    /* gpu/keepInMemory/tryMmap из cfg идут только в SDK-route (lmsLoadModelSDK).
     * Через REST они недоступны — endpoint не принимает. */
    desiredGpuRatio: cfg.gpu?.ratio,
    desiredKeepInMem: cfg.keepModelInMemory,
  });
  telemetry.logEvent({ type: "olympics.model_lifecycle", phase: "load_start", modelKey });
  /* LM Studio REST API /api/v1/models/load принимает ТОЛЬКО эти поля.
   * Rich-параметры (keepModelInMemory, tryMmap, gpu) доступны через SDK-route
   * (см. lmsLoadModelSDK). Если нужен полный конфиг — включи useLmsSDK. */
  const body: Record<string, unknown> = {
    model: modelKey,
    context_length: ctxLen,
    flash_attention: fa,
    echo_load_config: false,
  };
  try {
    const r = await fetch(`${lmsUrl}/api/v1/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const loadTimeMs = Date.now() - t0;
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      log("error", `load failed HTTP ${r.status}`, { modelKey, body: txt.slice(0, 200), loadTimeMs });
      telemetry.logEvent({
        type: "olympics.model_lifecycle",
        phase: "load_fail",
        modelKey,
        durationMs: loadTimeMs,
        error: `HTTP ${r.status}: ${txt.slice(0, 200)}`,
      });
      return { ok: false, reason: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const j = (await r.json().catch(() => null)) as { instance_id?: string; status?: string } | null;
    const instanceId = j?.instance_id ?? modelKey;
    log("info", `loaded in ${loadTimeMs}ms`, { modelKey, instanceId });
    telemetry.logEvent({ type: "olympics.model_lifecycle", phase: "load_ok", modelKey, instanceId, durationMs: loadTimeMs });
    return { ok: true, instanceId, loadTimeMs, transport: "rest" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log("error", "load threw", { modelKey, reason, loadTimeMs: Date.now() - t0 });
    telemetry.logEvent({
      type: "olympics.model_lifecycle",
      phase: "load_fail",
      modelKey,
      durationMs: Date.now() - t0,
      error: reason,
    });
    return { ok: false, reason };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Unload a model — best-effort with timeout + logging.
 *  `transport`: "rest" (default) | "sdk". При ошибке SDK fallback на REST
 *  (best-effort: некоторые SDK-инстансы видны в REST API, некоторые нет;
 *  в худшем случае получим warn-лог и продолжим — лучше чем зависнуть). */
export async function lmsUnloadModel(
  lmsUrl: string,
  instanceId: string,
  log: OlympicsLogger,
  transport: LmsTransport = "rest",
): Promise<boolean> {
  if (transport === "sdk") {
    const sdkOk = await lmsUnloadModelSDK(lmsUrl, instanceId, log);
    if (sdkOk) return true;
    log("warn", "SDK unload failed — falling back to REST", { instanceId });
    /* fall through to REST */
  }
  const t0 = Date.now();
  try {
    const r = await fetch(`${lmsUrl}/api/v1/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_id: instanceId }),
      signal: AbortSignal.timeout(15_000),
    });
    const durationMs = Date.now() - t0;
    if (r.ok) {
      log("info", `unloaded in ${durationMs}ms`, { instanceId });
      telemetry.logEvent({ type: "olympics.model_lifecycle", phase: "unload_ok", modelKey: instanceId, instanceId, durationMs });
      return true;
    }
    log("warn", `unload returned HTTP ${r.status}`, { instanceId, durationMs });
    telemetry.logEvent({
      type: "olympics.model_lifecycle",
      phase: "unload_fail",
      modelKey: instanceId,
      instanceId,
      durationMs,
      error: `HTTP ${r.status}`,
    });
    return false;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log("warn", "unload threw (best-effort)", { instanceId, reason });
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

/**
 * Health check — поднимает ли вообще LM Studio? Используем ДО загрузки
 * каждой модели чтобы не упереться в crashed server.
 */
export async function lmsHealthCheck(lmsUrl: string, log: OlympicsLogger): Promise<boolean> {
  try {
    const r = await fetch(`${lmsUrl}/api/v1/models`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) {
      log("warn", `health check HTTP ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    log("error", "health check failed — LM Studio may have crashed", {
      reason: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Estimate model VRAM footprint from sizeBytes + 30% overhead для KV
 * cache, activations, и runtime метаданных (эмпирическое правило для
 * llama.cpp с context=2048).
 */
export function estimateModelVramBytes(info: LmsModelInfo): number {
  if (info.sizeBytes > 0) {
    return Math.round(info.sizeBytes * 1.3);
  }
  /* Fallback: оценка из paramsString. */
  if (info.paramsString) {
    const m = info.paramsString.match(/([\d.]+)\s*B/i);
    if (m) {
      const params = Number(m[1]);
      const bpw = info.quantization?.bits_per_weight ?? 4;
      return Math.round(params * 1e9 * bpw / 8 * 1.3);
    }
  }
  return 0;
}

export async function lmsLoadedInstanceIdsForModel(
  lmsUrl: string,
  modelKey: string,
  log: OlympicsLogger,
): Promise<string[]> {
  try {
    const infos = await lmsListModelsV1(lmsUrl);
    const info = infos.find((m) => m.key === modelKey);
    return (info?.loadedInstances ?? [])
      .map((x) => x.id)
      .filter((id) => typeof id === "string" && id.length > 0);
  } catch (e) {
    log("warn", "failed to refresh loaded instances", {
      modelKey,
      reason: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

export async function lmsUnloadAllInstancesForModel(
  lmsUrl: string,
  modelKey: string,
  log: OlympicsLogger,
  knownInstanceIds: string[] = [],
  transport: LmsTransport = "rest",
): Promise<number> {
  const fromRefresh = await lmsLoadedInstanceIdsForModel(lmsUrl, modelKey, log);
  const ids = [...new Set([...knownInstanceIds, ...fromRefresh])];
  let unloaded = 0;

  if (ids.length > 0) {
    telemetry.logEvent({
      type: "olympics.model_lifecycle",
      phase: "cleanup",
      modelKey,
      instanceId: ids.join(","),
    });
  }

  for (const id of ids) {
    if (await lmsUnloadModel(lmsUrl, id, log, transport)) unloaded++;
  }

  if (ids.length === 0) {
    log("debug", "no loaded instances to unload", { modelKey });
  } else {
    log("info", "model instance cleanup finished", { modelKey, requested: ids.length, unloaded });
  }
  return unloaded;
}

/* ─── Chat ───────────────────────────────────────────────────────────── */

export async function lmsChat(
  lmsUrl: string,
  model: string,
  system: string,
  user: string,
  opts: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    imageUrl?: string;
    /** Hook to post-process raw LLM output before returning (e.g. strip <think>). */
    postProcess?: (raw: string) => string;
  },
): Promise<ChatResp> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90_000);
  const onAbort = (): void => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    /* Мультимодальный content для vision-дисциплин (OpenAI-compat). */
    const userContent = opts.imageUrl
      ? [
          { type: "text" as const, text: user },
          { type: "image_url" as const, image_url: { url: opts.imageUrl } },
        ]
      : user;
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 512,
    };
    if (typeof opts.topP === "number") body.top_p = opts.topP;
    const r = await fetch(`${lmsUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { content: "", durationMs: Date.now() - t0, totalTokens: 0, ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const j = (await r.json()) as {
      choices: Array<{ message: { content?: string; reasoning_content?: string } }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = j.choices?.[0]?.message;
    /* `||` вместо `??`: thinking-модели (Qwen3, GLM-4) могут возвращать
     * content="" и всё полезное в reasoning_content. `??` не спасает от "". */
    const rawContent = (choice?.content || choice?.reasoning_content || "").trim();
    /* Если postProcess (stripThinkingBlock) обнулил ответ, но reasoning_content
     * содержит полезные данные — используем его как fallback. */
    let processed = opts.postProcess ? opts.postProcess(rawContent) : rawContent;
    if (!processed && rawContent !== processed) {
      const rc = (choice?.reasoning_content || "").trim();
      if (rc) processed = opts.postProcess ? opts.postProcess(rc) : rc;
    }
    return {
      content: processed,
      durationMs: Date.now() - t0,
      totalTokens: j.usage?.total_tokens ?? 0,
      promptTokens: j.usage?.prompt_tokens,
      completionTokens: j.usage?.completion_tokens,
      ok: true,
    };
  } catch (e) {
    return { content: "", durationMs: Date.now() - t0, totalTokens: 0, ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeoutId);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
