/**
 * Tests для centralized Qdrant collection config.
 *
 * Не запускает реальный Qdrant — мокает fetch через globalThis.fetch override
 * чтобы проверить:
 *   - HNSW config попадает в PUT body
 *   - Quantization включается только при scalar_int8
 *   - Payload indexes создаются
 *   - Probe-200 (existing) не пересоздаёт коллекцию
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureQdrantCollection, ensurePayloadIndex } from "../electron/lib/qdrant/collection-config.ts";
import { setupMockFetch, jsonResponse, notFoundResponse } from "./helpers/mock-fetch.ts";

describe("ensureQdrantCollection", () => {
  let restore: () => void = () => undefined;

  beforeEach(() => {
    /* default: probe 404 → PUT 200 → indexes 200 */
  });

  afterEach(() => {
    restore();
  });

  it("создаёт коллекцию с дефолтными параметрами если её нет", async () => {
    const mock = setupMockFetch((req) => {
      if (req.method === "GET") {
        return notFoundResponse();
      }
      return jsonResponse({ result: { acknowledged: true } });
    });
    restore = mock.restore;

    const result = await ensureQdrantCollection({
      name: "test_simple",
      vectorSize: 384,
    });

    expect(result.created).toBe(true);
    /* Должно быть 2 вызова: GET (probe) + PUT (create). */
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[1]!.method).toBe("PUT");
    const putBody = mock.calls[1]!.body as Record<string, unknown>;
    expect(putBody.vectors).toEqual({ size: 384, distance: "Cosine" });
  });

  it("HNSW config попадает в PUT body когда указан", async () => {
    const mock = setupMockFetch((req) => {
      if (req.method === "GET") return notFoundResponse();
      return jsonResponse({ result: { acknowledged: true } });
    });
    restore = mock.restore;

    await ensureQdrantCollection({
      name: "test_hnsw",
      vectorSize: 1024,
      hnsw: { m: 24, ef_construct: 128 },
    });

    const putBody = mock.calls[1]!.body as Record<string, unknown>;
    expect(putBody.hnsw_config).toEqual({ m: 24, ef_construct: 128 });
  });

  it("scalar quantization включается только при scalar_int8", async () => {
    const mock = setupMockFetch((req) => {
      if (req.method === "GET") return notFoundResponse();
      return jsonResponse({ result: { acknowledged: true } });
    });
    restore = mock.restore;

    await ensureQdrantCollection({
      name: "test_quant",
      vectorSize: 1024,
      quantization: "scalar_int8",
    });

    const putBody = mock.calls[1]!.body as Record<string, unknown>;
    expect(putBody.quantization_config).toBeDefined();
    const quant = (putBody.quantization_config as Record<string, unknown>).scalar as Record<
      string,
      unknown
    >;
    expect(quant.type).toBe("int8");
    expect(quant.quantile).toBe(0.99);
    expect(quant.always_ram).toBe(true);
  });

  it("quantization='none' (default) НЕ добавляет quantization_config", async () => {
    const mock = setupMockFetch((req) => {
      if (req.method === "GET") return notFoundResponse();
      return jsonResponse({ result: { acknowledged: true } });
    });
    restore = mock.restore;

    await ensureQdrantCollection({ name: "test_no_quant", vectorSize: 384 });

    const putBody = mock.calls[1]!.body as Record<string, unknown>;
    expect(putBody.quantization_config).toBeUndefined();
  });

  it("payload indexes создаются после коллекции", async () => {
    const mock = setupMockFetch((req) => {
      if (req.method === "GET") return notFoundResponse();
      return jsonResponse({ result: { acknowledged: true } });
    });
    restore = mock.restore;

    await ensureQdrantCollection({
      name: "test_indexes",
      vectorSize: 384,
      payloadIndexes: [
        { field: "bookSourcePath", type: "keyword" },
        { field: "language", type: "keyword" },
      ],
    });

    /* GET probe + PUT collection + 2 PUT index = 4 вызова. */
    expect(mock.calls.length).toBe(4);
    const indexCall1 = mock.calls[2]!;
    expect(indexCall1.url).toContain("/index");
    const indexBody1 = indexCall1.body as Record<string, unknown>;
    expect(indexBody1.field_name).toBe("bookSourcePath");
    expect(indexBody1.field_schema).toBe("keyword");

    const indexCall2 = mock.calls[3]!;
    const indexBody2 = indexCall2.body as Record<string, unknown>;
    expect(indexBody2.field_name).toBe("language");
  });

  it("если коллекция уже есть (probe 200) — не пересоздаёт", async () => {
    const mock = setupMockFetch((req) => {
      if (req.method === "GET") {
        return jsonResponse({ result: { config: {} } }); /* exists */
      }
      throw new Error("should not call PUT");
    });
    restore = mock.restore;

    const result = await ensureQdrantCollection({ name: "test_exists", vectorSize: 384 });
    expect(result.created).toBe(false);
    expect(mock.calls.length).toBe(1); /* только probe */
    expect(mock.calls[0]!.method).toBe("GET");
  });

  it("ensurePayloadIndex добавляет индекс к существующей коллекции", async () => {
    const mock = setupMockFetch(() => jsonResponse({ result: { acknowledged: true } }));
    restore = mock.restore;

    await ensurePayloadIndex("existing_collection", "bookSourcePath", "keyword");

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]!.url).toContain("/index");
    const body = mock.calls[0]!.body as Record<string, unknown>;
    expect(body.field_name).toBe("bookSourcePath");
    expect(body.field_schema).toBe("keyword");
  });

  it("ensurePayloadIndex не падает на ошибке (idempotent best-effort)", async () => {
    const mock = setupMockFetch(() => new Response("error", { status: 500 }));
    restore = mock.restore;

    /* Не должна throw — pollyana semantics. */
    await expect(
      ensurePayloadIndex("any", "any", "keyword"),
    ).resolves.toBeUndefined();
  });
});
