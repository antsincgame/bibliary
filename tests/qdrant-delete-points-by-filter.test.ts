/**
 * Иt 8Г.3 — deletePointsByFilter helper + Qdrant payload bookId.
 *
 * Проверяет что shared-helper строит правильный must-фильтр для
 * Qdrant points/delete API. Без этого helper'а каждый caller (scanner.ipc,
 * dataset-v2 reject-accepted, extraction-runner reimport-cleanup) собирал
 * inline fetch с одинаковым телом — это давало drift при изменении
 * контракта (wait-flag, поле-значение пары и т.д.).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { deletePointsByFilter, setQdrantUrl } from "../electron/lib/qdrant/http-client.ts";

test.beforeEach(() => {
  /* Сбрасываем URL — другие тесты могли его поменять. */
  setQdrantUrl("http://localhost:6333");
});

test("[Г.3] deletePointsByFilter: строит правильный POST с must-фильтром по одному полю", async () => {
  /* Mock fetch: перехватываем и проверяем payload, отвечаем 200. */
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: unknown = null;
  let capturedMethod = "";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = init?.method ?? "GET";
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ status: "ok", operation_id: 42 }), { status: 200 });
  }) as typeof fetch;

  try {
    const res = await deletePointsByFilter("bibliary-test", [
      { field: "bookId", value: "uuid-abc-123" },
    ]);

    assert.equal(capturedMethod, "POST");
    assert.match(capturedUrl, /\/collections\/bibliary-test\/points\/delete\?wait=true/);
    assert.deepEqual(capturedBody, {
      filter: { must: [{ key: "bookId", match: { value: "uuid-abc-123" } }] },
    });
    assert.equal(res.status, "ok");
    assert.equal(res.operation_id, 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("[Г.3] deletePointsByFilter: поддерживает несколько must-условий (AND)", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }) as typeof fetch;

  try {
    await deletePointsByFilter("bibliary-test", [
      { field: "bookId", value: "uuid-1" },
      { field: "domain", value: "science" },
    ]);

    assert.deepEqual(capturedBody, {
      filter: {
        must: [
          { key: "bookId", match: { value: "uuid-1" } },
          { key: "domain", match: { value: "science" } },
        ],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("[Г.3] deletePointsByFilter: integer value пробрасывается без преобразования", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }) as typeof fetch;

  try {
    await deletePointsByFilter("bibliary-test", [{ field: "year", value: 2026 }]);
    const filter = (capturedBody as { filter: { must: Array<{ match: { value: unknown } }> } }).filter;
    assert.equal(filter.must[0].match.value, 2026);
    assert.equal(typeof filter.must[0].match.value, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("[Г.3] deletePointsByFilter: 5xx ответ от Qdrant → throw с понятным сообщением", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("Internal Error", { status: 503, statusText: "Service Unavailable" });
  }) as typeof fetch;

  try {
    await assert.rejects(
      deletePointsByFilter("bibliary-test", [{ field: "bookId", value: "x" }]),
      /503|Service Unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
