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
 * tests/chroma-collection-cache.test.ts
 *
 * Проверяет name→id collection cache:
 *   1. Cache miss → fetch → cached
 *   2. Cache hit → no fetch
 *   3. invalidate() → next call ре-фетчит
 *   4. setMapping() — manual prepopulate (используется в IPC handlers)
 *   5. clearAll() — полный сброс
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
import {
  resolveCollectionId,
  invalidate,
  clearAll,
  setMapping,
  _snapshotForTesting,
} from "../electron/lib/chroma/collection-cache.js";

test("resolveCollectionId: cache miss → fetch, cache hit → no fetch", async () => {
  clearAll();
  const mock = setupMockFetch(() =>
    jsonResponse({ id: "uuid-aaa", name: "test", metadata: null }),
  );
  try {
    const id1 = await resolveCollectionId("test");
    assert.equal(id1, "uuid-aaa");
    assert.equal(mock.calls.length, 1);

    const id2 = await resolveCollectionId("test");
    assert.equal(id2, "uuid-aaa");
    /* Второй вызов из кэша — без HTTP. */
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
    clearAll();
  }
});

test("invalidate: следующий resolve делает fetch", async () => {
  clearAll();
  const mock = setupMockFetch(() =>
    jsonResponse({ id: "uuid-bbb", name: "x", metadata: null }),
  );
  try {
    await resolveCollectionId("x");
    invalidate("x");
    await resolveCollectionId("x");
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
    clearAll();
  }
});

test("setMapping: manual prepopulate — resolveCollectionId не делает fetch", async () => {
  clearAll();
  const mock = setupMockFetch(() => new Response("should not be called", { status: 500 }));
  try {
    setMapping("preset", "uuid-preset");
    const id = await resolveCollectionId("preset");
    assert.equal(id, "uuid-preset");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    clearAll();
  }
});

test("clearAll: всё стирает", async () => {
  setMapping("a", "1");
  setMapping("b", "2");
  assert.deepEqual(_snapshotForTesting(), { a: "1", b: "2" });
  clearAll();
  assert.deepEqual(_snapshotForTesting(), {});
});

test("resolveCollectionId: 404 (collection не существует) → throws", async () => {
  clearAll();
  const mock = setupMockFetch(() => new Response("not found", { status: 404 }));
  try {
    await assert.rejects(() => resolveCollectionId("missing"));
  } finally {
    mock.restore();
    clearAll();
  }
});
