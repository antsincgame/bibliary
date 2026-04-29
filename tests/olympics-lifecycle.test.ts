import { test } from "node:test";
import assert from "node:assert/strict";
import { runOlympics, clearOlympicsCache } from "../electron/lib/llm/arena/olympics.ts";

function modelRecord(key: string, loadedIds: string[] = []): Record<string, unknown> {
  return {
    key,
    type: "llm",
    publisher: "test",
    display_name: key,
    architecture: key.includes("a") ? "qwen3" : "gemma",
    quantization: { name: "Q4_K_M", bits_per_weight: 4 },
    size_bytes: 2_000_000_000,
    params_string: "4B",
    loaded_instances: loadedIds.map((id) => ({ id, config: {} })),
    max_context_length: 4096,
    format: "gguf",
    capabilities: { vision: false, trained_for_tool_use: false },
    description: null,
  };
}

test("runOlympics cleans preloaded selected models and unloads each model before loading the next", async () => {
  const calls: string[] = [];
  const loaded = new Map<string, string[]>([
    ["model-a-4b", ["pre-a"]],
    ["model-b-4b", []],
  ]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith("/api/v1/models") && (!init?.method || init.method === "GET")) {
      return Response.json({
        models: [
          modelRecord("model-a-4b", loaded.get("model-a-4b") ?? []),
          modelRecord("model-b-4b", loaded.get("model-b-4b") ?? []),
        ],
      });
    }

    if (url.endsWith("/api/v1/models/load")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      const model = String(body.model);
      const id = `inst-${model}`;
      calls.push(`load:${model}`);
      loaded.set(model, [id]);
      return Response.json({ instance_id: id });
    }

    if (url.endsWith("/api/v1/models/unload")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { instance_id?: string };
      const instanceId = String(body.instance_id);
      calls.push(`unload:${instanceId}`);
      for (const [model, ids] of loaded) {
        loaded.set(model, ids.filter((id) => id !== instanceId));
      }
      return Response.json({ ok: true });
    }

    if (url.endsWith("/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calls.push(`chat:${body.model}`);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                facts: ["Curiosity landed on Mars in 2012", "NASA operates the mission"],
                entities: [
                  { name: "Curiosity", type: "rover" },
                  { name: "Mars", type: "planet" },
                  { name: "NASA", type: "organization" },
                  { name: "Gale Crater", type: "place" },
                ],
              }),
            },
          },
        ],
        usage: { total_tokens: 12 },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const report = await runOlympics({
      models: ["model-a-4b", "model-b-4b"],
      disciplines: ["crystallizer-rover"],
      lmsUrl: "http://test-lms",
    });

    assert.equal(report.models.length, 2);
    assert.ok(calls.indexOf("unload:pre-a") >= 0, "preloaded selected model must be cleaned before run");
    assert.ok(calls.indexOf("unload:pre-a") < calls.indexOf("load:model-a-4b"));
    assert.ok(calls.indexOf("unload:inst-model-a-4b") < calls.indexOf("load:model-b-4b"));
    assert.ok(calls.indexOf("unload:inst-model-b-4b") > calls.indexOf("load:model-b-4b"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runOlympics: /api/v1/models/load body содержит ТОЛЬКО валидные REST-поля (regression)", async () => {
  /* Регрессия против бага fe1a3c7 — per-role tuning подсунул в HTTP body
   * SDK-only поля (keep_model_in_memory, try_mmap, gpu), и LM Studio REST
   * вернул HTTP 400 "Unrecognized key(s)" для всех 24 моделей.
   *
   * REST /api/v1/models/load принимает ТОЛЬКО:
   *   model, context_length, flash_attention, echo_load_config
   *
   * Любые другие ключи в body — баг, ловится этим тестом. */
  /* Сбрасываем кэш — иначе тесты выше могли его наполнить и load не вызовется. */
  clearOlympicsCache();

  const ALLOWED_LOAD_KEYS = new Set([
    "model", "context_length", "flash_attention", "echo_load_config",
  ]);
  const observedBodies: Record<string, unknown>[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/models") && (!init?.method || init.method === "GET")) {
      return Response.json({ models: [modelRecord("model-a-4b"), modelRecord("model-b-4b")] });
    }
    if (url.endsWith("/api/v1/models/load")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      observedBodies.push(body);
      return Response.json({ instance_id: `inst-${String(body.model)}` });
    }
    if (url.endsWith("/api/v1/models/unload")) return Response.json({ ok: true });
    if (url.endsWith("/v1/chat/completions")) {
      return Response.json({
        choices: [{ message: { content: "{}" } }],
        usage: { total_tokens: 1 },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    /* Включаем per-role tuning — именно там был баг. */
    await runOlympics({
      models: ["model-a-4b", "model-b-4b"],
      disciplines: ["crystallizer-rover"],
      roleLoadConfigEnabled: true,
      lmsUrl: "http://test-lms",
    });

    assert.ok(observedBodies.length >= 2, "load должен быть вызван минимум 2 раза");
    for (const body of observedBodies) {
      const unknownKeys = Object.keys(body).filter((k) => !ALLOWED_LOAD_KEYS.has(k));
      assert.deepEqual(
        unknownKeys, [],
        `LM Studio REST /api/v1/models/load не принимает ключи: ${unknownKeys.join(", ")}. ` +
        `Body: ${JSON.stringify(body)}`,
      );
      /* Sanity: ключевые поля присутствуют. */
      assert.equal(typeof body.model, "string");
      assert.equal(typeof body.context_length, "number");
      assert.equal(typeof body.flash_attention, "boolean");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runOlympics treats an explicit empty role selection as no disciplines", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/v1/models")) {
      return Response.json({
        models: [
          modelRecord("model-a-4b"),
          modelRecord("model-b-4b"),
        ],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => runOlympics({
        models: ["model-a-4b", "model-b-4b"],
        roles: [],
        lmsUrl: "http://test-lms",
      }),
      /Нет ни одной дисциплины/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
