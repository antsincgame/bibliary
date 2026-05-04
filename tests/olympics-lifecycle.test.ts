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

/* ── Regression: thinking-модели с content="" и reasoning_content ────────── */

test("lmsChat: content='' + reasoning_content → использует reasoning_content (thinking model)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/chat/completions")) {
      return Response.json({
        choices: [{
          message: {
            content: "",
            reasoning_content: '{"facts":["Mars landing"],"entities":[{"name":"Curiosity","type":"rover"}]}',
          },
        }],
        usage: { total_tokens: 42 },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const { lmsChat } = await import("../electron/lib/llm/arena/lms-client.ts");
    const r = await lmsChat("http://test-lms", "thinking-model", "sys", "user", {});
    assert.equal(r.ok, true);
    assert.ok(r.content.length > 0, `content should not be empty, got: "${r.content}"`);
    assert.ok(r.content.includes("Mars"), `reasoning_content should be used, got: "${r.content}"`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lmsChat: stripThinkingBlock empties content → falls back to reasoning_content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/chat/completions")) {
      return Response.json({
        choices: [{
          message: {
            content: "<think>I need to analyze this carefully...</think>",
            reasoning_content: "A",
          },
        }],
        usage: { total_tokens: 30 },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const { lmsChat } = await import("../electron/lib/llm/arena/lms-client.ts");
    const { stripThinkingBlock } = await import("../electron/lib/llm/arena/disciplines.ts");
    const r = await lmsChat("http://test-lms", "thinking-model", "sys", "user", {
      postProcess: stripThinkingBlock,
    });
    assert.equal(r.ok, true);
    assert.equal(r.content, "A", `after strip+fallback should get "A", got: "${r.content}"`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ── Regression: thinking overhead multiplier для reasoning моделей ────── */

test("runOlympics: reasoning model gets increased maxTokens (thinking overhead)", async () => {
  clearOlympicsCache();
  const chatMaxTokens: Map<string, number> = new Map();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/models") && (!init?.method || init.method === "GET")) {
      return Response.json({
        models: [{
          key: "thinking-model-4b",
          type: "llm",
          publisher: "test",
          display_name: "thinking-model-4b",
          architecture: "qwen3",
          quantization: { name: "Q4_K_M", bits_per_weight: 4 },
          size_bytes: 2_000_000_000,
          params_string: "4B",
          loaded_instances: [],
          max_context_length: 4096,
          format: "gguf",
          capabilities: { vision: false, trained_for_tool_use: false, reasoning: { allowed_options: ["on","off"], default: "on" } },
          description: null,
        }, {
          key: "normal-model-4b",
          type: "llm",
          publisher: "test",
          display_name: "normal-model-4b",
          architecture: "gemma",
          quantization: { name: "Q4_K_M", bits_per_weight: 4 },
          size_bytes: 2_000_000_000,
          params_string: "4B",
          loaded_instances: [],
          max_context_length: 4096,
          format: "gguf",
          capabilities: { vision: false, trained_for_tool_use: false },
          description: null,
        }],
      });
    }
    if (url.endsWith("/api/v1/models/load")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      return Response.json({ instance_id: `inst-${body.model}` });
    }
    if (url.endsWith("/api/v1/models/unload")) return Response.json({ ok: true });
    if (url.endsWith("/v1/chat/completions")) {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(bodyStr) as { max_tokens?: number; model?: string };
      if (body.model && typeof body.max_tokens === "number") {
        chatMaxTokens.set(body.model, body.max_tokens);
      }
      return Response.json({
        choices: [{ message: { content: "A" } }],
        usage: { total_tokens: 2 },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    /* lang-detect-en — non-thinking-friendly дисциплина. После Iter 14.4
     * (2026-05-04) base maxTokens поднят 16 → 96, чтобы reasoning-модели
     * успевали дописать final answer после CoT-prose. См. extractLangCode. */
    await runOlympics({
      models: ["thinking-model-4b", "normal-model-4b"],
      disciplines: ["lang-detect-en"],
      lmsUrl: "http://test-lms",
    });

    const thinkingMax = chatMaxTokens.get("thinking-model-4b");
    const normalMax = chatMaxTokens.get("normal-model-4b");
    assert.ok(thinkingMax !== undefined, `thinking model chat not found. Map keys: [${[...chatMaxTokens.keys()]}]`);
    assert.ok(normalMax !== undefined, `normal model chat not found. Map keys: [${[...chatMaxTokens.keys()]}]`);
    assert.ok(
      thinkingMax! > normalMax!,
      `thinking model maxTokens (${thinkingMax}) should be > normal (${normalMax})`,
    );
    assert.equal(normalMax, 96, "lang-detect-en base maxTokens=96 (Iter 14.4)");
    assert.equal(thinkingMax, 384, "lang-detect-en × 4 overhead = 384 (Iter 14.4)");
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
