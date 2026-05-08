/**
 * tests/chroma-query-distance-conversion.test.ts
 *
 * Проверяем что chromaQueryNearest корректно конвертирует Chroma `distance`
 * в cosine similarity в зависимости от `hnsw:space` коллекции:
 *   - cosine:  similarity = 1 - distance
 *   - l2:      similarity = 1 - distance/2 (для нормализованных векторов)
 *   - ip:      similarity = -distance
 *
 * Также проверяем чистую функцию chromaDistanceToCosine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
import {
  chromaQueryNearest,
  chromaDistanceToCosine,
} from "../electron/lib/chroma/points.js";
import { clearAll, setMapping } from "../electron/lib/chroma/collection-cache.js";

test("[chroma-query] chromaDistanceToCosine: cosine space", () => {
  assert.equal(chromaDistanceToCosine(0, "cosine"), 1);   /* identical */
  assert.equal(chromaDistanceToCosine(0.15, "cosine"), 0.85);
  assert.equal(chromaDistanceToCosine(2, "cosine"), -1);  /* opposite */
});

test("[chroma-query] chromaDistanceToCosine: l2 space (squared L2 / normalized)", () => {
  /* Для нормализованных векторов: ||a-b||² = 2(1-cos), так что cos = 1 - d/2. */
  assert.equal(chromaDistanceToCosine(0, "l2"), 1);
  assert.equal(chromaDistanceToCosine(2, "l2"), 0);   /* perpendicular */
  assert.equal(chromaDistanceToCosine(4, "l2"), -1);  /* opposite */
});

test("[chroma-query] chromaDistanceToCosine: ip space", () => {
  assert.equal(chromaDistanceToCosine(-1, "ip"), 1);
  /* -0 vs 0 — javascript negate makes it -0, just check magnitude */
  assert.equal(Math.abs(chromaDistanceToCosine(0, "ip")), 0);
});

test("[chroma-query] cosine space: similarity = 1 - distance", async () => {
  clearAll();
  setMapping("test-coll", "id-cosine", { "hnsw:space": "cosine" });

  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/query")) {
      return jsonResponse({
        ids: [["a", "b", "c"]],
        distances: [[0.1, 0.3, 0.5]],
        documents: [["doc-a", "doc-b", "doc-c"]],
        metadatas: [[{}, {}, {}]],
      });
    }
    return jsonResponse({ id: "id-cosine", name: "test-coll", metadata: { "hnsw:space": "cosine" } });
  });

  try {
    const out = await chromaQueryNearest("test-coll", new Array(384).fill(0.1), 3);
    assert.equal(out.length, 3);
    assert.equal(out[0].similarity, 0.9);
    assert.equal(out[1].similarity, 0.7);
    assert.equal(out[2].similarity, 0.5);
  } finally {
    mock.restore();
    clearAll();
  }
});

test("[chroma-query] l2 space: similarity = 1 - d/2", async () => {
  clearAll();
  setMapping("test-l2", "id-l2", { "hnsw:space": "l2" });

  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/query")) {
      return jsonResponse({
        ids: [["x"]],
        distances: [[1.0]], /* squared L2 */
        documents: [["doc-x"]],
        metadatas: [[{}]],
      });
    }
    return jsonResponse({ id: "id-l2", name: "test-l2", metadata: { "hnsw:space": "l2" } });
  });

  try {
    const out = await chromaQueryNearest("test-l2", new Array(384).fill(0), 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].similarity, 0.5); /* 1 - 1.0/2 */
  } finally {
    mock.restore();
    clearAll();
  }
});

test("[chroma-query] empty collection error → returns []", async () => {
  clearAll();
  setMapping("empty-coll", "id-empty", { "hnsw:space": "cosine" });

  const mock = setupMockFetch(() =>
    new Response("no records", { status: 500 }),
  );

  try {
    const out = await chromaQueryNearest("empty-coll", new Array(384).fill(0), 3);
    assert.deepEqual(out, []);
  } finally {
    mock.restore();
    clearAll();
  }
});

test("[chroma-query] returns documents and metadatas verbatim", async () => {
  clearAll();
  setMapping("rich-coll", "id-rich", { "hnsw:space": "cosine" });

  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/query")) {
      return jsonResponse({
        ids: [["concept-1"]],
        distances: [[0.2]],
        documents: [["Hoist invariants"]],
        metadatas: [[{ domain: "performance", bookId: "book-42" }]],
      });
    }
    return jsonResponse({ id: "id-rich", name: "rich-coll", metadata: { "hnsw:space": "cosine" } });
  });

  try {
    const out = await chromaQueryNearest("rich-coll", new Array(384).fill(0), 1);
    assert.equal(out[0].id, "concept-1");
    assert.equal(out[0].document, "Hoist invariants");
    assert.equal(out[0].metadata.domain, "performance");
    assert.equal(out[0].metadata.bookId, "book-42");
    assert.equal(out[0].similarity, 0.8);
  } finally {
    mock.restore();
    clearAll();
  }
});
