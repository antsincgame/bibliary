/**
 * HTTP foundation for the renderer api-client.
 *
 * Все вызовы к backend идут через `fetch` с `credentials: "include"` —
 * Hono выставляет httpOnly cookies (`bibliary_at` / `bibliary_rt`),
 * браузер их прикрепляет автоматом. На 401 пробуем один rotate-refresh
 * через POST /api/auth/refresh; если refresh тоже 401, поднимаем
 * `AuthRequiredError` чтобы UI мог перенаправить на login.
 *
 * NB: при HMR Vite перезагружает только изменённые модули — кешированный
 * Authorization header / token store здесь жить не должны. Cookie-based
 * auth = stateless renderer.
 */

const API_BASE = "";

export class HttpError extends Error {
  /** @param {number} status @param {string} message @param {unknown} body */
  constructor(status, message, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export class AuthRequiredError extends HttpError {
  /** @param {string} [message] */
  constructor(message = "auth_required") {
    super(401, message, null);
    this.name = "AuthRequiredError";
  }
}

/**
 * @typedef {Object} RequestOpts
 * @property {string} [method]   default "GET"
 * @property {Record<string, unknown>} [json]   body to JSON-encode
 * @property {Record<string, string | number | boolean | undefined>} [query]   query string params (undefined skipped)
 * @property {AbortSignal} [signal]
 * @property {boolean} [skipRefresh]   when true, 401 propagates без попытки refresh
 * @property {"json" | "blob" | "text" | "void"} [parse]   how to decode response (default "json")
 */

/**
 * @template T
 * @param {string} path
 * @param {RequestOpts} [opts]
 * @returns {Promise<T>}
 */
export async function request(path, opts = {}) {
  const url = buildUrl(path, opts.query);
  const init = buildInit(opts);
  let res = await fetch(url, init);

  if (res.status === 401 && !opts.skipRefresh) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await fetch(url, init);
    }
  }

  return decodeResponse(res, opts.parse ?? "json");
}

let refreshInFlight = null;
async function tryRefresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * @param {string} path
 * @param {Record<string, string | number | boolean | undefined>} [query]
 */
function buildUrl(path, query) {
  const base = path.startsWith("/") ? path : `/${path}`;
  if (!query) return `${API_BASE}${base}`;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${API_BASE}${base}?${qs}` : `${API_BASE}${base}`;
}

/** @param {RequestOpts} opts */
function buildInit(opts) {
  /** @type {RequestInit} */
  const init = {
    method: opts.method ?? "GET",
    credentials: "include",
    headers: {},
  };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    /** @type {Record<string, string>} */ (init.headers)["content-type"] = "application/json";
  }
  if (opts.signal) init.signal = opts.signal;
  return init;
}

/**
 * @param {Response} res
 * @param {"json" | "blob" | "text" | "void"} parse
 */
async function decodeResponse(res, parse) {
  if (!res.ok) {
    const body = await safeReadBody(res);
    if (res.status === 401) throw new AuthRequiredError(extractError(body));
    throw new HttpError(res.status, extractError(body) ?? `HTTP ${res.status}`, body);
  }
  if (parse === "void") return /** @type {never} */ (undefined);
  if (parse === "blob") return /** @type {never} */ (await res.blob());
  if (parse === "text") return /** @type {never} */ (await res.text());
  return /** @type {never} */ (await res.json());
}

/** @param {Response} res */
async function safeReadBody(res) {
  try {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return await res.json();
    return await res.text();
  } catch {
    return null;
  }
}

/** @param {unknown} body */
function extractError(body) {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return null;
}

/** Shorthands for common HTTP verbs — keeps domain modules readable. */
export const http = {
  /** @template T @param {string} p @param {Omit<RequestOpts, "method">} [opts] */
  get: (p, opts) => request(p, { ...opts, method: "GET" }),
  /** @template T @param {string} p @param {Omit<RequestOpts, "method">} [opts] */
  post: (p, opts) => request(p, { ...opts, method: "POST" }),
  /** @template T @param {string} p @param {Omit<RequestOpts, "method">} [opts] */
  patch: (p, opts) => request(p, { ...opts, method: "PATCH" }),
  /** @template T @param {string} p @param {Omit<RequestOpts, "method">} [opts] */
  delete: (p, opts) => request(p, { ...opts, method: "DELETE" }),
};
