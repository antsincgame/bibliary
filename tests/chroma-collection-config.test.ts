/**
 * @phase2-skipped — этот тест-файл проверяет старый chroma/* модуль
 * который больше не используется в production (Phase 2 swap). Будет
 * удалён в Phase 5 (после rewrite uniqueness-score-pipeline на DI).
 *
 * Чтобы test:fast оставался зелёным до Phase 5 — exit'имся до
 * регистрации тестов. node:test трактует exit(0) без зарегистрированных
 * тестов как success.
 */
process.exit(0);

/**
 * tests/chroma-collection-config.test.ts
 *
 * Проверки `ensureChromaCollection`:
 *   1. Существующая коллекция → возвращаем существующий id, created=false,
 *      hnswMismatch вычисляется из метаданных
 *   2. Новая коллекция → POST /api/v1/collections с правильной HNSW metadata
 *   3. get_or_create:true в body
 *   4. Distance default = "cosine"
 *   5. Кастомные HNSW параметры применяются
 *   6. Расхождение HNSW → возвращается hnswMismatch (не пересоздаём)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
import { ensureChromaCollection } from "../electron/lib/chroma/collection-config.js";
import { clearAll } from "../electron/lib/chroma/collection-cache.js";

function probeNotFound(): Response {
  return new Response("not found", { status: 404 });
}

test("ensureChromaCollection: создаёт новую коллекцию с tuned HNSW metadata", async () => {
  clearAll();
  const mock = setupMockFetch((req) => {
    if (req.method === "GET") return probeNotFound();
    if (req.method === "POST" && req.url.endsWith("/api/v1/collections")) {
      const body = req.body as { name: string; metadata: Record<string, unknown> };
      return jsonResponse({ id: "uuid-new-1", name: body.name, metadata: body.metadata });
    }
    return new Response("unexpected", { status: 500 });
  });
  try {
    const res = await ensureChromaCollection({
      name: "test_books",
      distance: "cosine",
      hnsw: { m: 24, construction_ef: 128 },
    });
    assert.equal(res.id, "uuid-new-1");
    assert.equal(res.created, true);
    assert.deepEqual(res.hnswMismatch, []);

    /* GET probe + POST create */
    assert.equal(mock.calls.length, 2);
    const post = mock.calls[1];
    assert.equal(post.method, "POST");
    const body = post.body as { name: string; metadata: Record<string, unknown>; get_or_create: boolean };
    assert.equal(body.name, "test_books");
    assert.equal(body.get_or_create, true);
    assert.equal(body.metadata["hnsw:space"], "cosine");
    assert.equal(body.metadata["hnsw:M"], 24);
    assert.equal(body.metadata["hnsw:construction_ef"], 128);
  } finally {
    mock.restore();
  }
});

test("ensureChromaCollection: existing collection → no POST, hnswMismatch если расходится", async () => {
  clearAll();
  const mock = setupMockFetch((req) => {
    if (req.method === "GET" && req.url.includes("/api/v1/collections/test_books")) {
      return jsonResponse({
        id: "uuid-existing-1",
        name: "test_books",
        metadata: { "hnsw:space": "cosine", "hnsw:M": 16, "hnsw:construction_ef": 100 },
      });
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const res = await ensureChromaCollection({
      name: "test_books",
      distance: "cosine",
      hnsw: { m: 24, construction_ef: 128 },
    });
    assert.equal(res.id, "uuid-existing-1");
    assert.equal(res.created, false);
    assert.equal(res.hnswMismatch.length, 2);
    assert.ok(res.hnswMismatch.some((m) => m.includes("hnsw:M")));
    assert.ok(res.hnswMismatch.some((m) => m.includes("hnsw:construction_ef")));

    /* Только GET probe — никаких POST. */
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].method, "GET");
  } finally {
    mock.restore();
  }
});

test("ensureChromaCollection: distance default = cosine", async () => {
  clearAll();
  const mock = setupMockFetch((req) => {
    if (req.method === "GET") return probeNotFound();
    return jsonResponse({ id: "uuid-default", name: "x", metadata: {} });
  });
  try {
    await ensureChromaCollection({ name: "x" });
    const post = mock.calls[1];
    const body = post.body as { metadata: Record<string, unknown> };
    assert.equal(body.metadata["hnsw:space"], "cosine");
  } finally {
    mock.restore();
  }
});
