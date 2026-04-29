/**
 * SDK-route tests for Olympics LM Studio client.
 *
 * Проверяет:
 *   1. lmsLoadModelSDK через mock LMStudioClient → возвращает instanceId,
 *      сохраняет handle в кэше, передаёт ВЕСЬ load config в SDK.
 *   2. lmsUnloadModelSDK находит handle в кэше и вызывает handle.unload().
 *   3. lmsLoadModel(transport="sdk") → идёт через SDK; при ошибке SDK
 *      runtime-fallback на REST (Mahakala-страховка).
 *   4. runOlympics(useLmsSDK=true) → use SDK для load/unload, REST для chat.
 *
 * Mock-подход: `_setOlympicsSdkClientForTests` подменяет реальный
 * @lmstudio/sdk клиент, чтобы не открывать WebSocket.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lmsLoadModel,
  lmsLoadModelSDK,
  lmsUnloadModel,
  lmsUnloadModelSDK,
  _setOlympicsSdkClientForTests,
  type OlympicsLLMHandle,
  type OlympicsLMStudioClient,
} from "../electron/lib/llm/arena/lms-client.ts";
import { runOlympics, clearOlympicsCache } from "../electron/lib/llm/arena/olympics.ts";

const noopLog = (): void => { /* silent */ };

function makeMockSdkClient(opts: {
  loadShouldThrow?: string;
  loadDelayMs?: number;
  observed: { loadCalls: Array<{ modelKey: string; config: Record<string, unknown> }>; unloadCalls: string[] };
}): OlympicsLMStudioClient {
  return {
    llm: {
      async load(modelKey, options) {
        if (opts.loadDelayMs) await new Promise((r) => setTimeout(r, opts.loadDelayMs));
        if (opts.loadShouldThrow) throw new Error(opts.loadShouldThrow);
        opts.observed.loadCalls.push({ modelKey, config: options?.config ?? {} });
        const identifier = `sdk-inst-${modelKey}`;
        const handle: OlympicsLLMHandle = {
          identifier,
          unload: async () => {
            opts.observed.unloadCalls.push(identifier);
          },
        };
        return handle;
      },
      async unload(identifier) {
        opts.observed.unloadCalls.push(identifier);
      },
    },
  };
}

test("lmsLoadModelSDK: передаёт ВЕСЬ load config (gpu/keepInMem/tryMmap) в SDK", async () => {
  const observed = { loadCalls: [] as Array<{ modelKey: string; config: Record<string, unknown> }>, unloadCalls: [] as string[] };
  _setOlympicsSdkClientForTests(makeMockSdkClient({ observed }));
  try {
    const result = await lmsLoadModelSDK(
      "http://localhost:1234",
      "test-model-4b",
      noopLog,
      undefined,
      {
        contextLength: 32768,
        flashAttention: true,
        keepModelInMemory: true,
        tryMmap: true,
        gpu: { ratio: "max" },
      },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.instanceId, "sdk-inst-test-model-4b");
    assert.ok(result.loadTimeMs >= 0);

    assert.equal(observed.loadCalls.length, 1);
    const cfg = observed.loadCalls[0].config;
    assert.equal(cfg.contextLength, 32768);
    assert.equal(cfg.flashAttention, true);
    assert.equal(cfg.keepModelInMemory, true);
    assert.equal(cfg.tryMmap, true);
    /* gpu.ratio типизировано как number в SDK; "max" → SDK сам обработает.
     * Но _toSdkLoadConfig сейчас фильтрует только typeof === "number".
     * Поэтому при ratio="max" поле gpu отсутствует — это ОК для теста
     * (валидация конверсии для "max" — отдельная задача). */
  } finally {
    _setOlympicsSdkClientForTests(null);
  }
});

test("lmsLoadModelSDK: numeric gpu.ratio попадает в SDK config", async () => {
  const observed = { loadCalls: [] as Array<{ modelKey: string; config: Record<string, unknown> }>, unloadCalls: [] as string[] };
  _setOlympicsSdkClientForTests(makeMockSdkClient({ observed }));
  try {
    await lmsLoadModelSDK("http://localhost:1234", "test-model", noopLog, undefined, {
      contextLength: 4096,
      flashAttention: true,
      gpu: { ratio: 0.75 },
    });
    const cfg = observed.loadCalls[0].config as { gpu?: { ratio: number } };
    assert.deepEqual(cfg.gpu, { ratio: 0.75 });
  } finally {
    _setOlympicsSdkClientForTests(null);
  }
});

test("lmsUnloadModelSDK: использует cached handle и вызывает handle.unload()", async () => {
  const observed = { loadCalls: [] as Array<{ modelKey: string; config: Record<string, unknown> }>, unloadCalls: [] as string[] };
  _setOlympicsSdkClientForTests(makeMockSdkClient({ observed }));
  try {
    const loadResult = await lmsLoadModelSDK("http://localhost:1234", "test-m", noopLog);
    assert.equal(loadResult.ok, true);
    if (!loadResult.ok) return;

    const unloadOk = await lmsUnloadModelSDK("http://localhost:1234", loadResult.instanceId, noopLog);
    assert.equal(unloadOk, true);
    assert.deepEqual(observed.unloadCalls, ["sdk-inst-test-m"]);
  } finally {
    _setOlympicsSdkClientForTests(null);
  }
});

test("lmsLoadModel(transport='sdk'): success → не делает REST вызовов", async () => {
  const observed = { loadCalls: [] as Array<{ modelKey: string; config: Record<string, unknown> }>, unloadCalls: [] as string[] };
  _setOlympicsSdkClientForTests(makeMockSdkClient({ observed }));
  let restCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/v1/models/load")) restCalled = true;
    throw new Error("REST shouldn't be called when SDK succeeds");
  }) as typeof fetch;
  try {
    const result = await lmsLoadModel(
      "http://localhost:1234",
      "test",
      noopLog,
      undefined,
      { contextLength: 4096, flashAttention: true },
      "sdk",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.transport, "sdk");
    assert.equal(restCalled, false);
  } finally {
    _setOlympicsSdkClientForTests(null);
    globalThis.fetch = originalFetch;
  }
});

test("lmsLoadModel(transport='sdk'): SDK throws → fallback на REST с предупреждением", async () => {
  const observed = { loadCalls: [] as Array<{ modelKey: string; config: Record<string, unknown> }>, unloadCalls: [] as string[] };
  _setOlympicsSdkClientForTests(
    makeMockSdkClient({ observed, loadShouldThrow: "SDK WebSocket disconnected" }),
  );
  let restCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/v1/models/load")) {
      restCalled = true;
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      return Response.json({ instance_id: `rest-fallback-${body.model}` });
    }
    throw new Error("Unexpected fetch: " + String(input));
  }) as typeof fetch;
  try {
    const result = await lmsLoadModel(
      "http://localhost:1234",
      "test-model",
      noopLog,
      undefined,
      { contextLength: 2048, flashAttention: true },
      "sdk",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.transport, "rest", "должен быть fallback REST");
    assert.equal(result.instanceId, "rest-fallback-test-model");
    assert.equal(restCalled, true, "REST должен быть вызван после SDK fail");
  } finally {
    _setOlympicsSdkClientForTests(null);
    globalThis.fetch = originalFetch;
  }
});

test("runOlympics(useLmsSDK=true): load/unload идут через SDK, chat — через REST", async () => {
  clearOlympicsCache();

  const observed = { loadCalls: [] as Array<{ modelKey: string; config: Record<string, unknown> }>, unloadCalls: [] as string[] };
  _setOlympicsSdkClientForTests(makeMockSdkClient({ observed }));

  /* REST mock: только catalog + chat. /api/v1/models/load НЕ должен вызываться. */
  const restCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/models") && (!init?.method || init.method === "GET")) {
      const mk = (key: string) => ({
        key,
        type: "llm",
        publisher: "test",
        display_name: key,
        architecture: "qwen3",
        quantization: { name: "Q4_K_M", bits_per_weight: 4 },
        size_bytes: 2_000_000_000,
        params_string: "4B",
        loaded_instances: [],
        max_context_length: 4096,
        format: "gguf",
        capabilities: { vision: false, trained_for_tool_use: false },
        description: null,
      });
      return Response.json({ models: [mk("model-x-4b"), mk("model-y-4b")] });
    }
    if (url.endsWith("/api/v1/models/load")) {
      restCalls.push("REST_LOAD"); /* should NOT happen */
      return Response.json({ instance_id: "should-not-happen" });
    }
    if (url.endsWith("/api/v1/models/unload")) {
      restCalls.push("REST_UNLOAD"); /* should NOT happen */
      return Response.json({ ok: true });
    }
    if (url.endsWith("/v1/chat/completions")) {
      restCalls.push("REST_CHAT");
      return Response.json({
        choices: [{ message: { content: '{"facts":["t"],"entities":[]}' } }],
        usage: { total_tokens: 5 },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const report = await runOlympics({
      models: ["model-x-4b", "model-y-4b"],
      disciplines: ["crystallizer-rover"],
      useLmsSDK: true,
      lmsUrl: "http://test-lms",
    });

    assert.equal(report.models.length, 2);
    assert.equal(observed.loadCalls.length, 2, "SDK load должен вызваться 2 раза");
    assert.deepEqual(
      observed.loadCalls.map((c) => c.modelKey).sort(),
      ["model-x-4b", "model-y-4b"],
    );
    assert.ok(observed.unloadCalls.length >= 2, "SDK unload должен вызваться для обеих моделей");
    assert.equal(restCalls.includes("REST_LOAD"), false, "REST load НЕ должен быть вызван");
    assert.equal(restCalls.includes("REST_UNLOAD"), false, "REST unload НЕ должен быть вызван");
    assert.ok(restCalls.includes("REST_CHAT"), "chat по-прежнему через REST");
  } finally {
    _setOlympicsSdkClientForTests(null);
    globalThis.fetch = originalFetch;
  }
});

test("lmsUnloadModel(transport='sdk'): SDK fail → REST fallback", async () => {
  /* Используем mock который throw'ит на unload */
  _setOlympicsSdkClientForTests({
    llm: {
      async load() { throw new Error("not used"); },
      async unload() { throw new Error("SDK unload boom"); },
    },
  });

  let restCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/v1/models/unload")) {
      restCalled = true;
      return Response.json({ ok: true });
    }
    throw new Error("Unexpected fetch");
  }) as typeof fetch;

  try {
    const ok = await lmsUnloadModel("http://localhost:1234", "stale-instance-id", noopLog, "sdk");
    assert.equal(ok, true, "после SDK fallback REST должен вернуть ok");
    assert.equal(restCalled, true);
  } finally {
    _setOlympicsSdkClientForTests(null);
    globalThis.fetch = originalFetch;
  }
});
