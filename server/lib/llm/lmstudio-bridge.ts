/**
 * Thin LM Studio bridge for the web backend. Uses @lmstudio/sdk over a
 * cached WebSocket connection. URL is read from `LM_STUDIO_URL` env var;
 * admins can override per-installation.
 *
 * Phase 2b: connect / list / load / unload only. The richer behaviour
 * (model pool, watchdog, request policy) lives in the Electron client and
 * will be re-introduced in Phase 6 under a provider abstraction.
 */

import { LMStudioClient } from "@lmstudio/sdk";

import { type Config, loadConfig } from "../../config.js";

export interface ProbeOptions {
  timeoutMs?: number;
  ipv4Fallback?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  resolvedUrl: string;
  status?: number;
  latencyMs?: number;
  modelsCount?: number;
  kind?:
    | "refused"
    | "timeout"
    | "dns"
    | "unreachable"
    | "reset"
    | "http"
    | "invalid_url"
    | "cors"
    | "unknown";
  message?: string;
  errorCode?: string;
}

export interface LoadedModelInfo {
  identifier: string;
  modelKey: string;
  contextLength?: number;
  quantization?: string;
  vision?: boolean;
  trainedForToolUse?: boolean;
}

export interface DownloadedModelInfo {
  modelKey: string;
  displayName?: string;
  format?: string;
  paramsString?: string;
  sizeBytes?: number;
}

let cachedClient: { url: string; client: LMStudioClient } | null = null;

function getClient(cfg: Config = loadConfig()): LMStudioClient {
  const wsUrl = cfg.LM_STUDIO_URL.replace(/^http/, "ws");
  if (cachedClient && cachedClient.url === wsUrl) return cachedClient.client;
  cachedClient = {
    url: wsUrl,
    client: new LMStudioClient({ baseUrl: wsUrl }),
  };
  return cachedClient.client;
}

export function resetLmStudioBridgeForTesting(): void {
  cachedClient = null;
}

export async function probeUrl(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const cfg = loadConfig();
  const timeoutMs = opts.timeoutMs ?? cfg.LM_STUDIO_PROBE_TIMEOUT_MS;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, resolvedUrl: url, kind: "invalid_url", message: "URL parse failed" };
  }

  const target = new URL("v1/models", parsed.toString().endsWith("/") ? parsed : new URL(parsed.toString() + "/"));
  const ipv4Fallback = opts.ipv4Fallback !== false && parsed.hostname === "localhost";

  const tryFetch = async (resolvedUrl: string): Promise<ProbeResult> => {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(resolvedUrl, { signal: ctrl.signal });
      const latencyMs = Date.now() - t0;
      let modelsCount: number | undefined;
      try {
        const json = (await res.json()) as { data?: unknown[] };
        if (Array.isArray(json.data)) modelsCount = json.data.length;
      } catch {
        /* probe still useful even without parsed body */
      }
      return {
        ok: res.ok,
        resolvedUrl,
        status: res.status,
        latencyMs,
        ...(modelsCount !== undefined ? { modelsCount } : {}),
        ...(res.ok ? {} : { kind: "http" as const, message: `HTTP ${res.status}` }),
      };
    } catch (err) {
      return {
        ok: false,
        resolvedUrl,
        ...classifyFetchError(err, timeoutMs),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await tryFetch(target.toString());
  if (first.ok) return first;

  if (ipv4Fallback && first.kind === "refused") {
    const alt = new URL(target.toString());
    alt.hostname = "127.0.0.1";
    return tryFetch(alt.toString());
  }
  return first;
}

function classifyFetchError(
  err: unknown,
  timeoutMs: number,
): Pick<ProbeResult, "kind" | "message" | "errorCode"> {
  if (err instanceof Error && err.name === "AbortError") {
    return { kind: "timeout", message: `timeout after ${timeoutMs}ms` };
  }
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ECONNREFUSED") return { kind: "refused", message, errorCode: code };
  if (code === "ENOTFOUND") return { kind: "dns", message, errorCode: code };
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return { kind: "unreachable", message, errorCode: code };
  if (code === "ECONNRESET") return { kind: "reset", message, errorCode: code };
  return { kind: "unknown", message, ...(code ? { errorCode: code } : {}) };
}

export async function getServerStatus(): Promise<{ online: boolean; url: string; version?: string }> {
  const cfg = loadConfig();
  const result = await probeUrl(cfg.LM_STUDIO_URL);
  return { online: result.ok, url: cfg.LM_STUDIO_URL, ...(result.ok ? { version: "lmstudio" } : {}) };
}

export async function listDownloaded(): Promise<DownloadedModelInfo[]> {
  const client = getClient();
  const list = await client.system.listDownloadedModels();
  return list.map((m) => {
    const meta = m as unknown as {
      modelKey?: string;
      displayName?: string;
      format?: string;
      paramsString?: string;
      sizeBytes?: number;
      path?: string;
    };
    return {
      modelKey: meta.modelKey ?? meta.path ?? "unknown",
      ...(meta.displayName ? { displayName: meta.displayName } : {}),
      ...(meta.format ? { format: meta.format } : {}),
      ...(meta.paramsString ? { paramsString: meta.paramsString } : {}),
      ...(meta.sizeBytes ? { sizeBytes: meta.sizeBytes } : {}),
    };
  });
}

export async function listLoaded(): Promise<LoadedModelInfo[]> {
  const client = getClient();
  const list = await client.llm.listLoaded();
  return list.map((m) => {
    const meta = m as unknown as {
      identifier?: string;
      modelKey?: string;
      path?: string;
      contextLength?: number;
      quantization?: string;
      vision?: boolean;
      trainedForToolUse?: boolean;
    };
    return {
      identifier: meta.identifier ?? meta.modelKey ?? meta.path ?? "unknown",
      modelKey: meta.modelKey ?? meta.path ?? meta.identifier ?? "unknown",
      ...(typeof meta.contextLength === "number" ? { contextLength: meta.contextLength } : {}),
      ...(meta.quantization ? { quantization: meta.quantization } : {}),
      ...(typeof meta.vision === "boolean" ? { vision: meta.vision } : {}),
      ...(typeof meta.trainedForToolUse === "boolean"
        ? { trainedForToolUse: meta.trainedForToolUse }
        : {}),
    };
  });
}

export interface LoadOptions {
  contextLength?: number;
  ttlSec?: number;
  gpuOffload?: "max" | number;
}

export async function loadModel(
  modelKey: string,
  opts: LoadOptions = {},
): Promise<LoadedModelInfo> {
  const client = getClient();
  const config: Record<string, unknown> = {};
  if (opts.contextLength) config["contextLength"] = opts.contextLength;
  if (opts.ttlSec) config["ttl"] = opts.ttlSec;
  if (opts.gpuOffload !== undefined) {
    config["gpu"] =
      opts.gpuOffload === "max"
        ? { ratio: 1 }
        : { ratio: Math.max(0, Math.min(1, opts.gpuOffload)) };
  }
  const handle = (await client.llm.load(modelKey, {
    config,
  } as unknown as Parameters<typeof client.llm.load>[1])) as unknown as {
    identifier?: string;
    modelKey?: string;
  };
  return {
    identifier: handle.identifier ?? modelKey,
    modelKey,
  };
}

export async function unloadModel(identifier: string): Promise<void> {
  const client = getClient();
  await client.llm.unload(identifier);
}
