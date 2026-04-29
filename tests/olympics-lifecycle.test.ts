import { test } from "node:test";
import assert from "node:assert/strict";
import { runOlympics } from "../electron/lib/llm/arena/olympics.ts";

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
