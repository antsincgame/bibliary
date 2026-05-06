/**
 * tests/chroma-upsert-shape.test.ts
 *
 * Гарантирует Chroma-shape для upsert:
 *   - parallel arrays {ids, embeddings, metadatas, documents} (не Qdrant {points:[...]})
 *   - text → documents[] (НЕ в metadata) — это ключевой паттерн Chroma
 *   - ids — всегда строки (String() coercion)
 *   - tags string[] → "|tag|tag|" в tagsCsv (Chroma не поддерживает array metadata)
 *   - null → "" (sanitize)
 *   - Float32Array → number[] (для JSON)
 *   - upsert URL использует collection_id (не name)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
import {
  chromaUpsert,
  sanitizeMetadata,
  sanitizeMetadataValue,
} from "../electron/lib/chroma/points.js";
import { clearAll, setMapping } from "../electron/lib/chroma/collection-cache.js";

test("sanitizeMetadataValue: null/undefined → \"\"", () => {
  assert.equal(sanitizeMetadataValue(null), "");
  assert.equal(sanitizeMetadataValue(undefined), "");
});

test("sanitizeMetadataValue: string array → \"|t1|t2|\"", () => {
  assert.equal(sanitizeMetadataValue(["alpha", "beta", "gamma"]), "|alpha|beta|gamma|");
  assert.equal(sanitizeMetadataValue([]), "||");
});

test("sanitizeMetadataValue: object → JSON string", () => {
  assert.equal(sanitizeMetadataValue({ a: 1 }), '{"a":1}');
});

test("sanitizeMetadataValue: number/bool/string passthrough; bigint coerced to number", () => {
  assert.equal(sanitizeMetadataValue("hello"), "hello");
  assert.equal(sanitizeMetadataValue(42), 42);
  assert.equal(sanitizeMetadataValue(true), true);
  assert.equal(sanitizeMetadataValue(BigInt(5)), 5);
});

test("sanitizeMetadata: применяется ко всем полям", () => {
  const out = sanitizeMetadata({
    title: "Book",
    author: null,
    chapters: 12,
    tagsCsv: ["a", "b"],
  });
  assert.deepEqual(out, {
    title: "Book",
    author: "",
    chapters: 12,
    tagsCsv: "|a|b|",
  });
});

test("chromaUpsert: правильный body shape — parallel arrays", async () => {
  clearAll();
  setMapping("books", "uuid-books-1");
  const mock = setupMockFetch((req) => {
    if (req.method === "POST" && req.url.endsWith("/uuid-books-1/upsert")) {
      return jsonResponse({});
    }
    return new Response("unexpected: " + req.url, { status: 500 });
  });
  try {
    await chromaUpsert("books", [
      {
        id: "id-1",
        embedding: [0.1, 0.2, 0.3],
        document: "Glory of bookkeeping",
        metadata: { title: "Book A", chapter: 1 },
      },
      {
        id: "id-2",
        embedding: [0.4, 0.5, 0.6],
        document: "Second chunk",
        metadata: { title: "Book A", chapter: 2 },
      },
    ]);
    assert.equal(mock.calls.length, 1);
    const body = mock.calls[0].body as {
      ids: unknown[];
      embeddings: unknown[][];
      metadatas: unknown[];
      documents: unknown[];
    };
    assert.deepEqual(body.ids, ["id-1", "id-2"]);
    assert.deepEqual(body.embeddings[0], [0.1, 0.2, 0.3]);
    assert.deepEqual(body.documents, ["Glory of bookkeeping", "Second chunk"]);
    assert.deepEqual(body.metadatas[0], { title: "Book A", chapter: 1 });
    /* parallel arrays того же размера */
    assert.equal(body.ids.length, body.embeddings.length);
    assert.equal(body.ids.length, body.metadatas.length);
    assert.equal(body.ids.length, body.documents.length);
  } finally {
    mock.restore();
    clearAll();
  }
});

test("chromaUpsert: ids всегда coerced в String() (защита от number IDs)", async () => {
  clearAll();
  setMapping("c", "uuid-c");
  const mock = setupMockFetch(() => jsonResponse({}));
  try {
    await chromaUpsert("c", [
      /* Передаём ID как number-литерал в неуклюжем сценарии (TS would catch это
         статически, но runtime защита нужна на случай any-bypass из IPC). */
      { id: 42 as unknown as string, embedding: [0.1], metadata: {} },
    ]);
    const body = mock.calls[0].body as { ids: unknown[] };
    assert.equal(typeof body.ids[0], "string");
    assert.equal(body.ids[0], "42");
  } finally {
    mock.restore();
    clearAll();
  }
});

test("chromaUpsert: Float32Array embedding → plain number array (JSON-serializable)", async () => {
  clearAll();
  setMapping("c", "uuid-c");
  const mock = setupMockFetch(() => jsonResponse({}));
  try {
    const f32 = new Float32Array([0.5, 0.25]);
    await chromaUpsert("c", [{ id: "x", embedding: f32, metadata: {} }]);
    const body = mock.calls[0].body as { embeddings: unknown[][] };
    assert.ok(Array.isArray(body.embeddings[0]));
    assert.equal(body.embeddings[0].length, 2);
    assert.ok(Math.abs((body.embeddings[0][0] as number) - 0.5) < 1e-6);
  } finally {
    mock.restore();
    clearAll();
  }
});

test("chromaUpsert: empty points array — no HTTP", async () => {
  clearAll();
  setMapping("c", "uuid-c");
  const mock = setupMockFetch(() => jsonResponse({}));
  try {
    await chromaUpsert("c", []);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    clearAll();
  }
});
