/**
 * Структурированный HTTP probe для LM Studio (OpenAI-compat endpoint).
 *
 * Зачем отдельный модуль:
 *   1. Renderer не должен fetch'ить localhost напрямую.
 *      Browser-side fetch теряет error.cause (TypeError "Failed to fetch")
 *      и упирается в CORS, если LM Studio не выставил Access-Control-Allow-Origin.
 *      Node fetch (undici) в main process отдаёт error.cause.code (ECONNREFUSED,
 *      ENOTFOUND, ETIMEDOUT, EHOSTUNREACH, ECONNRESET) — что позволяет
 *      сообщить пользователю **точную** причину.
 *
 *   2. На Windows `localhost` иногда резолвится в `::1` (IPv6) тогда как
 *      LM Studio по умолчанию слушает только IPv4 0.0.0.0:1234. Это даёт
 *      ECONNREFUSED. Probe пробует автоматический IPv4-fallback на 127.0.0.1
 *      перед тем как сдаться, и сообщает в результате какой host сработал
 *      (`resolvedUrl`), чтобы UI мог подсказать пользователю прописать 127.0.0.1.
 *
 *   3. Watchdog (lmstudio-watchdog.ts), Settings probe button и onboarding
 *      wizard probe — все используют ОДНУ функцию. Single source of truth.
 *
 * Контракт результата:
 *   { ok: true,  status: 200, latencyMs, version?, modelsCount?, resolvedUrl }
 *   { ok: false, kind: "refused"|"timeout"|"dns"|"http"|"invalid_url"|"cors"|"unknown",
 *                message, statusCode?, errorCode?, resolvedUrl? }
 */

import { setTimeout as setTimerImmediate } from "node:timers";

export type LmStudioProbeErrorKind =
  | "refused"      /* ECONNREFUSED — порт закрыт / сервер не запущен */
  | "timeout"      /* AbortController сработал по таймауту */
  | "dns"          /* ENOTFOUND / EAI_AGAIN — хост не резолвится */
  | "unreachable"  /* EHOSTUNREACH / ENETUNREACH — сеть недоступна */
  | "reset"        /* ECONNRESET — соединение прервано */
  | "http"         /* TCP/HTTP ОК, но статус не 2xx (например 404, 500) */
  | "invalid_url"  /* строка не парсится как URL */
  | "cors"         /* специфично для browser fetch — для compat */
  | "unknown";     /* всё остальное */

export interface LmStudioProbeOk {
  ok: true;
  status: number;
  latencyMs: number;
  /** Сколько моделей вернул /v1/models. Полезно для UX («14 моделей доступно»). */
  modelsCount?: number;
  /** Реально сработавший URL (после возможного IPv4 fallback). */
  resolvedUrl: string;
}

export interface LmStudioProbeError {
  ok: false;
  kind: LmStudioProbeErrorKind;
  message: string;
  /** HTTP статус если был получен (для kind === "http"). */
  statusCode?: number;
  /** Системный errno code от Node fetch (ECONNREFUSED, ETIMEDOUT, ...). */
  errorCode?: string;
  /** URL который пробовали последним (для диагностики). */
  resolvedUrl?: string;
}

export type LmStudioProbeResult = LmStudioProbeOk | LmStudioProbeError;

export interface LmStudioProbeOptions {
  /** Полный таймаут на запрос. По умолчанию 5 сек. */
  timeoutMs?: number;
  /** Если true — при ECONNREFUSED на localhost попробовать 127.0.0.1. По умолчанию true. */
  ipv4Fallback?: boolean;
}

/* Грубо проверяем что URL валидный и схема http(s). LM Studio HTTP API всегда http. */
function normalizeUrl(raw: string): { url: URL; cleaned: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { url: u, cleaned: trimmed };
  } catch {
    return null;
  }
}

/* Парсим Node fetch error.cause.code → семантический kind. */
function classifyError(err: unknown): { kind: LmStudioProbeErrorKind; errorCode?: string; message: string } {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; errno?: string } }).cause;
    const code = cause?.code ?? cause?.errno;
    const name = err.name;
    if (name === "AbortError") {
      return { kind: "timeout", errorCode: "ABORT_ERR", message: "request timed out" };
    }
    if (code === "ECONNREFUSED") {
      return { kind: "refused", errorCode: code, message: "connection refused (LM Studio server not running on this port)" };
    }
    if (code === "ETIMEDOUT") {
      return { kind: "timeout", errorCode: code, message: "TCP connection timed out" };
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return { kind: "dns", errorCode: code, message: "host not resolvable" };
    }
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      return { kind: "unreachable", errorCode: code, message: "network unreachable" };
    }
    if (code === "ECONNRESET") {
      return { kind: "reset", errorCode: code, message: "connection reset by peer" };
    }
    return { kind: "unknown", errorCode: code, message: err.message };
  }
  return { kind: "unknown", message: String(err) };
}

/**
 * Перформит один HTTP GET на /v1/models с таймаутом. Не ловит exceptions —
 * это работа caller'а (probeLmStudioUrl), который оборачивает несколько
 * попыток (с возможным IPv4 fallback).
 */
async function singleAttempt(baseUrl: string, timeoutMs: number): Promise<LmStudioProbeOk | LmStudioProbeError> {
  const ctl = new AbortController();
  const timer = setTimerImmediate(() => ctl.abort(), timeoutMs);
  /* `unref` не критичен для production (Electron живёт), но в тестах с
     await import('node:test') предотвращает удержание event-loop. */
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  const start = Date.now();
  try {
    const target = `${baseUrl}/v1/models`;
    const resp = await fetch(target, {
      signal: ctl.signal,
      /* Defense-in-depth: явный header, чтобы прокси/firewall не подмешали кеш. */
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return {
        ok: false,
        kind: "http",
        statusCode: resp.status,
        message: `HTTP ${resp.status} ${resp.statusText || ""}`.trim(),
        resolvedUrl: baseUrl,
      };
    }
    /* Парсим тело только best-effort — некоторые LM Studio билды отдают
       `{ data: [...] }` (OpenAI shape), некоторые — `{ models: [...] }`,
       очень старые — пустой ответ. Не делать probe зависимым от этого. */
    let modelsCount: number | undefined;
    try {
      const body = await resp.json();
      if (body && typeof body === "object") {
        const arr =
          (body as { data?: unknown[] }).data ??
          (body as { models?: unknown[] }).models;
        if (Array.isArray(arr)) modelsCount = arr.length;
      }
    } catch {
      /* ignored */
    }
    return { ok: true, status: resp.status, latencyMs, modelsCount, resolvedUrl: baseUrl };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Главный entry-point. Делает probe LM Studio HTTP API:
 *   1. Validates URL.
 *   2. Calls GET ${url}/v1/models с timeout (по умолчанию 5s).
 *   3. На ECONNREFUSED для localhost → fallback на 127.0.0.1 (IPv6→IPv4 защита).
 *   4. Возвращает structured result для UI.
 *
 * Никогда не throw'ает — все ошибки в shape результата.
 */
export async function probeLmStudioUrl(
  rawUrl: string,
  opts: LmStudioProbeOptions = {},
): Promise<LmStudioProbeResult> {
  const timeoutMs = Math.max(500, Math.min(30_000, opts.timeoutMs ?? 5_000));
  const ipv4Fallback = opts.ipv4Fallback !== false;

  const norm = normalizeUrl(rawUrl);
  if (!norm) {
    return {
      ok: false,
      kind: "invalid_url",
      message: "URL is empty or has unsupported scheme (only http/https)",
      resolvedUrl: rawUrl,
    };
  }

  const primary = norm.cleaned;
  let lastErr: LmStudioProbeError | null = null;
  try {
    const r = await singleAttempt(primary, timeoutMs);
    if (r.ok) return r;
    lastErr = r;
  } catch (err) {
    const c = classifyError(err);
    lastErr = { ok: false, ...c, resolvedUrl: primary };
  }

  /* Fallback: если хост был "localhost" и мы упали с refused/timeout, пробуем
     127.0.0.1 — частая Windows-проблема (IPv6 ::1 vs IPv4 0.0.0.0). */
  if (
    ipv4Fallback &&
    lastErr &&
    (lastErr.kind === "refused" || lastErr.kind === "timeout") &&
    norm.url.hostname === "localhost"
  ) {
    const ipv4Url = `${norm.url.protocol}//127.0.0.1:${norm.url.port || (norm.url.protocol === "https:" ? "443" : "80")}${norm.url.pathname.replace(/\/$/, "")}`;
    try {
      const r2 = await singleAttempt(ipv4Url, timeoutMs);
      if (r2.ok) {
        /* IPv4 fallback сработал — сигнализируем UI чтобы он подсказал пользователю
           заменить URL. Делаем это через resolvedUrl (он отличается от primary). */
        return r2;
      }
      /* Если и IPv4 упал — оставляем сообщение primary attempt, но добавляем хвост. */
      return {
        ok: false,
        kind: r2.ok === false ? r2.kind : lastErr.kind,
        message: `${lastErr.message} (also tried ${ipv4Url}: ${r2.ok === false ? r2.message : "ok"})`,
        statusCode: r2.ok === false ? r2.statusCode : undefined,
        errorCode: lastErr.errorCode,
        resolvedUrl: ipv4Url,
      };
    } catch (err) {
      const c = classifyError(err);
      return {
        ok: false,
        kind: c.kind,
        message: `${lastErr.message} (also tried ${ipv4Url}: ${c.message})`,
        errorCode: c.errorCode,
        resolvedUrl: ipv4Url,
      };
    }
  }

  return lastErr ?? {
    ok: false,
    kind: "unknown",
    message: "probe failed without specific error",
    resolvedUrl: primary,
  };
}
