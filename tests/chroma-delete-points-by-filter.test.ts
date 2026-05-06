/**
 * tests/chroma-delete-points-by-filter.test.ts
 *
 * Проверки трансляции Qdrant-style фильтров в Chroma `where`:
 *   1. chromaWhereExact — простой equality
 *   2. chromaWhereAnyOf с одним matcher → flat key (не $or)
 *   3. chromaWhereAnyOf с несколькими → $or
 *   4. chromaWhereAllOf с одним → flat key
 *   5. chromaWhereAllOf с несколькими → $and
 *   6. chromaDeleteByWhere POSTит на /collections/{collection_id}/delete (id из cache)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
import {
  chromaDeleteByWhere,
  chromaWhereExact,
  chromaWhereAnyOf,
  chromaWhereAllOf,
} from "../electron/lib/chroma/points.js";
import { clearAll, setMapping } from "../electron/lib/chroma/collection-cache.js";

test("chromaWhereExact: simple equality", () => {
  assert.deepEqual(chromaWhereExact("bookId", "abc"), { bookId: "abc" });
});

test("chromaWhereAnyOf: 1 matcher → flat key, 2+ → $or", () => {
  assert.deepEqual(chromaWhereAnyOf([{ field: "x", value: "1" }]), { x: "1" });
  assert.deepEqual(
    chromaWhereAnyOf([
      { field: "bookId", value: "abc" },
      { field: "bookSourcePath", value: "/path/x.epub" },
    ]),
    { $or: [{ bookId: "abc" }, { bookSourcePath: "/path/x.epub" }] },
  );
});

test("chromaWhereAllOf: 1 matcher → flat key, 2+ → $and", () => {
  assert.deepEqual(chromaWhereAllOf([{ field: "x", value: "1" }]), { x: "1" });
  assert.deepEqual(
    chromaWhereAllOf([
      { field: "bookId", value: "abc" },
      { field: "chunkIndex", value: 0 },
    ]),
    { $and: [{ bookId: "abc" }, { chunkIndex: 0 }] },
  );
});

test("chromaDeleteByWhere: POSTит на collection_id (не на name) с {where}", async () => {
  clearAll();
  setMapping("test_books", "uuid-collection-123");
  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/uuid-collection-123/delete")) {
      const body = req.body as { where: Record<string, unknown> };
      assert.deepEqual(body.where, { bookId: "abc" });
      return jsonResponse(["id1", "id2"]);
    }
    return new Response("unexpected: " + req.url, { status: 500 });
  });
  try {
    const res = await chromaDeleteByWhere("test_books", { bookId: "abc" });
    assert.equal(res.deleted, 2);
    assert.equal(mock.calls.length, 1);
    /* URL должен использовать UUID, не name. */
    assert.ok(mock.calls[0].url.includes("uuid-collection-123"));
    assert.ok(!mock.calls[0].url.includes("test_books"));
  } finally {
    mock.restore();
    clearAll();
  }
});

test("chromaDeleteByWhere: $or filter — оба условия в payload", async () => {
  clearAll();
  setMapping("col", "uuid-c");
  const mock = setupMockFetch(() => jsonResponse([]));
  try {
    await chromaDeleteByWhere("col", chromaWhereAnyOf([
      { field: "bookId", value: "x" },
      { field: "bookSourcePath", value: "/y" },
    ]));
    const body = mock.calls[0].body as { where: Record<string, unknown> };
    assert.ok(Array.isArray(body.where.$or));
    assert.equal((body.where.$or as unknown[]).length, 2);
  } finally {
    mock.restore();
    clearAll();
  }
});
