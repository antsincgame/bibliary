/**
 * Test helper: in-memory mock for `globalThis.fetch`.
 *
 * Используется в chroma-* и uniqueness-* тестах для перехвата HTTP-вызовов
 * без реального Chroma-сервера. Записывает каждый call (URL/method/body/
 * headers) в массив для проверок + возвращает любой Response через
 * пользовательский responder.
 *
 * Пример:
 *
 *   const mock = setupMockFetch((req) => {
 *     if (req.method === "GET") return new Response("not found", { status: 404 });
 *     return jsonResponse({ id: "abc", name: "test-coll" });
 *   });
 *
 *   try {
 *     await ensureChromaCollection({ name: "test-coll" });
 *     assert.equal(mock.calls.length, 2);
 *   } finally {
 *     mock.restore();
 *   }
 */

export interface RecordedCall {
  /** Полный URL запроса. */
  url: string;
  /** HTTP method (UPPERCASE). По умолчанию "GET" если init.method не задан. */
  method: string;
  /** Распарсенный JSON body (если был). Если body не JSON — string как есть. */
  body?: unknown;
  /** Все заголовки в нижнем регистре (для проверок). */
  headers?: Record<string, string>;
}

export interface MockFetchHandle {
  /** Все вызовы fetch, в порядке появления. */
  calls: RecordedCall[];
  /** Восстановить оригинальный globalThis.fetch. ВАЖНО: всегда вызывать в afterEach/finally. */
  restore: () => void;
  /** Очистить calls без сброса handler (для повторных проверок в одном тесте). */
  clear: () => void;
}

export type MockFetchResponder = (req: RecordedCall) => Promise<Response> | Response;

/**
 * Перехватить globalThis.fetch и направить вызовы в `responder`.
 *
 * Гарантирует:
 *   - Запись каждого вызова в `calls` (URL, method, body, headers).
 *   - body парсится как JSON если возможно, иначе остаётся строкой.
 *   - restore() возвращает оригинальный fetch — всегда вызывайте.
 */
export function setupMockFetch(responder: MockFetchResponder): MockFetchHandle {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown;
    if (init?.body !== undefined && init.body !== null) {
      const raw = init.body as string;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const headers: Record<string, string> | undefined = init?.headers
      ? extractHeaders(init.headers)
      : undefined;
    const rec: RecordedCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body,
      headers,
    };
    calls.push(rec);
    return responder(rec);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
    clear: () => {
      calls.length = 0;
    },
  };
}

/** Удобство: ответ JSON с заданным status (default 200). */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Внутреннее: нормализовать HeadersInit к плоскому объекту lowercase keys. */
function extractHeaders(h: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v);
  }
  return out;
}
