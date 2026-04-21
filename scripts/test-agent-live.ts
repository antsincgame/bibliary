/**
 * Phase 4.0 — LIVE E2E test для Forge Chat Agent.
 *
 * НИКАКИХ MOCK. Использует реально загруженную модель в LM Studio
 * через тот же `chatWithTools()`, что и production agent.ipc.ts.
 *
 * Сценарии:
 *   T1 — probe: какие модели доступны, выбираем кандидата под tool calling
 *   T2 — agent с read-only задачей "сколько коллекций в Qdrant?"
 *        → loop должен вызвать list_collections (auto policy)
 *        → loop должен вернуть финальный ответ упоминая коллекции
 *   T3 — agent с задачей "найди в Qdrant 'cache invalidation'" в коллекции apps
 *        → должен вызвать search_collection
 *   T4 — destructive tool с auto-approve: запрос "удали книгу X"
 *        → emit approval-request → авто-approve через callback → execute
 *
 * Запуск:  npx tsx scripts/test-agent-live.ts
 * ENV:
 *   LM_STUDIO_URL (default http://localhost:1234)
 *   QDRANT_URL    (default http://localhost:6333)
 *   AGENT_MODEL   (override autoselect — например AGENT_MODEL=qwen/qwen3-coder-30b)
 */

import { runAgentLoop, type AgentEvent } from "../electron/lib/agent/index.js";
import { chatWithTools, type ToolMessage } from "../electron/lmstudio-client.js";

const HTTP_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${label.padEnd(72, ".")} `);
  try {
    await fn();
    console.log(`${COLOR.green}PASS${COLOR.reset}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${COLOR.red}FAIL${COLOR.reset}\n      ${COLOR.dim}${msg}${COLOR.reset}`);
    failed++;
    failures.push(`${label}: ${msg}`);
  }
}

/**
 * Список кандидатов в порядке приоритета: тот, кто лучше всех справляется
 * с native tool calling, идёт первым. ENV AGENT_MODEL может всё переопределить.
 */
const PRIORITY_CANDIDATES = [
  "qwen/qwen3.6-35b-a3b",
  "qwen/qwen3-coder-30b",
  "mistral-small-3.1-24b-instruct-2503-hf",
  "qwen/qwen3.5-9b",
  "qwen2.5-coder-7b-instruct",
];

interface ModelEntry {
  id: string;
}

async function listAvailableModels(): Promise<string[]> {
  const resp = await fetch(`${HTTP_URL}/v1/models`);
  if (!resp.ok) throw new Error(`/v1/models HTTP ${resp.status}`);
  const data = (await resp.json()) as { data: ModelEntry[] };
  return data.data.map((m) => m.id);
}

/** Проверяет, что модель загружена в RAM (не просто downloaded) и умеет tools. */
async function probeToolCapability(modelId: string, signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; reason?: string }> {
  const t0 = Date.now();
  try {
    const resp = await chatWithTools({
      model: modelId,
      messages: [{ role: "user", content: "Call the ping tool with arg {} to confirm tool support." }],
      tools: [
        {
          type: "function",
          function: {
            name: "ping",
            description: "Check if tool calling works. Takes no arguments.",
            parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
          },
        },
      ],
      toolChoice: "auto",
      sampling: { temperature: 0.1, max_tokens: 256 },
      signal,
    });
    const latency = Date.now() - t0;
    if (resp.toolCalls && resp.toolCalls.length > 0 && resp.toolCalls[0].name === "ping") {
      return { ok: true, latencyMs: latency };
    }
    return { ok: false, latencyMs: latency, reason: "model did not emit tool_calls" };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function pickModel(signal?: AbortSignal): Promise<string> {
  if (process.env.AGENT_MODEL) {
    const probe = await probeToolCapability(process.env.AGENT_MODEL, signal);
    if (!probe.ok) {
      throw new Error(`AGENT_MODEL=${process.env.AGENT_MODEL} probe failed: ${probe.reason}`);
    }
    console.log(`  ${COLOR.cyan}[chosen]${COLOR.reset} ${process.env.AGENT_MODEL} (latency=${probe.latencyMs}ms)`);
    return process.env.AGENT_MODEL;
  }

  const available = new Set(await listAvailableModels());
  console.log(`  ${COLOR.dim}available: ${[...available].length} models${COLOR.reset}`);

  for (const candidate of PRIORITY_CANDIDATES) {
    if (!available.has(candidate)) {
      console.log(`  ${COLOR.dim}[skip] ${candidate}: not in /v1/models${COLOR.reset}`);
      continue;
    }
    process.stdout.write(`  ${COLOR.dim}[probe]${COLOR.reset} ${candidate}... `);
    const probe = await probeToolCapability(candidate, signal);
    if (probe.ok) {
      console.log(`${COLOR.green}OK${COLOR.reset} (${probe.latencyMs}ms)`);
      return candidate;
    }
    console.log(`${COLOR.yellow}skip${COLOR.reset} (${probe.reason ?? "?"})`);
  }
  throw new Error("Не нашли ни одной tool-capable модели среди загруженных. Загрузите Qwen3.6/Qwen3-coder/Mistral-small в LM Studio.");
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}== Bibliary Forge Agent — LIVE test ==${COLOR.reset}`);
  console.log(`LM Studio: ${HTTP_URL}\n`);

  let chosenModel = "";
  await step("T1 — probe: выбор tool-capable модели среди загруженных", async () => {
    chosenModel = await pickModel();
  });

  if (!chosenModel) {
    console.log(`\n${COLOR.red}Прерываю: модели нет, остальные тесты бессмысленны.${COLOR.reset}\n`);
    process.exit(1);
  }

  /* T2 — read-only tool execution */
  await step(`T2 — agent: «list_collections» через ${chosenModel}`, async () => {
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Покажи список коллекций в Qdrant базе. Используй доступный tool." }],
      budget: { maxIterations: 6, maxTokens: 12_000 },
      emit: (e) => events.push(e),
      awaitApproval: async () => true,
      llm: async ({ messages, tools }) => {
        const resp = await chatWithTools({
          model: chosenModel,
          messages: messages as ToolMessage[],
          tools,
          toolChoice: "auto",
          sampling: { temperature: 0.3, max_tokens: 2048 },
        });
        return { content: resp.content, toolCalls: resp.toolCalls, usage: resp.usage };
      },
    });

    const toolCalls = events.filter((e) => e.type === "agent.tool-call");
    if (toolCalls.length === 0) throw new Error("модель не вызвала ни одного tool");
    const listCalled = toolCalls.some((e) => e.type === "agent.tool-call" && e.name === "list_collections");
    if (!listCalled) {
      const names = toolCalls.map((e) => (e.type === "agent.tool-call" ? e.name : "?")).join(", ");
      throw new Error(`ожидал list_collections, получил: ${names}`);
    }
    if (!result.finalAnswer || result.finalAnswer.length < 5) {
      throw new Error(`нет финального ответа (got: ${JSON.stringify(result.finalAnswer)})`);
    }
    const ok = result.toolHistory.find((t) => t.name === "list_collections")?.ok;
    if (!ok) throw new Error("list_collections выполнился с ошибкой");
    console.log(`        ${COLOR.dim}итераций=${result.iterations}, токенов=${result.tokensUsed}, ответ=«${result.finalAnswer.slice(0, 100).replace(/\n/g, " ")}…»${COLOR.reset}`);
  });

  /* T3 — search_collection (read-only). Если коллекций 0 — этот тест skip'ается */
  let qdrantHasCollections = false;
  let firstCollection = "";
  try {
    const r = await fetch(`${process.env.QDRANT_URL || "http://localhost:6333"}/collections`);
    if (r.ok) {
      const d = (await r.json()) as { result?: { collections?: Array<{ name: string }> } };
      const list = d.result?.collections ?? [];
      qdrantHasCollections = list.length > 0;
      firstCollection = list[0]?.name ?? "";
    }
  } catch {
    /* ignore */
  }

  if (qdrantHasCollections && firstCollection) {
    await step(`T3 — agent: «search_collection» в «${firstCollection}»`, async () => {
      const events: AgentEvent[] = [];
      const result = await runAgentLoop({
        messages: [
          {
            role: "user",
            content: `Используй tool search_collection чтобы найти в коллекции «${firstCollection}» концепты по запросу «good design». Limit k=3. Затем кратко пересскажи найденное.`,
          },
        ],
        budget: { maxIterations: 8, maxTokens: 30_000 },
        emit: (e) => events.push(e),
        awaitApproval: async () => true,
        llm: async ({ messages, tools }) => {
          const resp = await chatWithTools({
            model: chosenModel,
            messages: messages as ToolMessage[],
            tools,
            toolChoice: "auto",
            sampling: { temperature: 0.3, max_tokens: 4096 },
          });
          return { content: resp.content, toolCalls: resp.toolCalls, usage: resp.usage };
        },
      });
      const searched = events.some((e) => e.type === "agent.tool-call" && e.name === "search_collection");
      if (!searched) {
        const names = events.filter((e) => e.type === "agent.tool-call").map((e) => (e.type === "agent.tool-call" ? e.name : "?")).join(", ");
        throw new Error(`ожидал search_collection, получил: ${names || "ничего"}`);
      }
      if (!result.finalAnswer || result.finalAnswer.length < 5) {
        const trace = events
          .map((e) => {
            if (e.type === "agent.tool-call") return `  · tool-call ${e.name}`;
            if (e.type === "agent.tool-result") return `  · tool-result ok=${e.ok} ${e.preview.slice(0, 60)}`;
            if (e.type === "agent.thought") return `  · thought «${e.content.slice(0, 80)}»`;
            if (e.type === "agent.aborted") return `  · ABORTED ${e.reason}`;
            if (e.type === "agent.done") return `  · DONE final=«${e.finalAnswer.slice(0, 60)}»`;
            return `  · ${e.type}`;
          })
          .join("\n");
        throw new Error(`нет финального ответа (aborted=${result.aborted} reason=${result.abortedReason ?? "?"} iters=${result.iterations})\n${trace}`);
      }
      console.log(`        ${COLOR.dim}итераций=${result.iterations}, токенов=${result.tokensUsed}${COLOR.reset}`);
    });
  } else {
    console.log(`  ${COLOR.yellow}T3 — SKIP${COLOR.reset} ${COLOR.dim}(в Qdrant нет коллекций для теста search)${COLOR.reset}`);
  }

  /* T4 — destructive tool с approval flow */
  await step("T4 — destructive tool: write_role с approval-gate (reject)", async () => {
    const events: AgentEvent[] = [];
    let approvalCalled = false;
    let approvedToolName = "";
    const result = await runAgentLoop({
      messages: [
        {
          role: "user",
          content:
            "Используй tool write_role чтобы изменить роль T3, поле voice. Новое значение voice: 'Пиши тезисами по 5-7 слов. Никакого вода. Сухо и по делу.' Делай tool call немедленно, без обсуждения.",
        },
      ],
      budget: { maxIterations: 6, maxTokens: 12_000 },
      emit: (e) => events.push(e),
      awaitApproval: async (callId, toolName, args) => {
        approvalCalled = true;
        approvedToolName = toolName;
        console.log(
          `\n        ${COLOR.cyan}[approval-request]${COLOR.reset} ${toolName}(${JSON.stringify(args).slice(0, 100)})`
        );
        return false; /* reject — проверяем что loop корректно обрабатывает отказ */
      },
      llm: async ({ messages, tools }) => {
        const resp = await chatWithTools({
          model: chosenModel,
          messages: messages as ToolMessage[],
          tools,
          toolChoice: "auto",
          sampling: { temperature: 0.2, max_tokens: 2048 },
        });
        return { content: resp.content, toolCalls: resp.toolCalls, usage: resp.usage };
      },
    });

    if (!approvalCalled) {
      const trace = events
        .map((e) => {
          if (e.type === "agent.tool-call") return `  · tool-call ${e.name}(${JSON.stringify(e.args).slice(0, 60)})`;
          if (e.type === "agent.tool-result") return `  · tool-result ok=${e.ok}`;
          if (e.type === "agent.thought") return `  · thought «${e.content.slice(0, 100)}»`;
          if (e.type === "agent.done") return `  · DONE «${e.finalAnswer.slice(0, 80)}»`;
          return `  · ${e.type}`;
        })
        .join("\n");
      throw new Error(`approval gate не сработал — destructive tool не вызывался либо вызывался без запроса\n${trace}`);
    }
    if (approvedToolName !== "write_role") {
      throw new Error(`ожидал write_role, approval запрашивался для: ${approvedToolName}`);
    }
    const rejectedEvent = events.find(
      (e) => e.type === "agent.approval-response" && (e as Extract<AgentEvent, { type: "agent.approval-response" }>).approved === false
    );
    if (!rejectedEvent) throw new Error("approval-response с approved=false не пришёл");
    if (result.aborted) throw new Error(`loop aborted unexpectedly: ${result.abortedReason}`);
    console.log(`        ${COLOR.dim}итераций=${result.iterations}, отказ обработан корректно${COLOR.reset}`);
  });

  /* Summary */
  console.log(`\n${COLOR.bold}--- Summary ---${COLOR.reset}`);
  console.log(`Tests passed: ${COLOR.green}${passed}${COLOR.reset}`);
  console.log(`Tests failed: ${failed === 0 ? COLOR.green : COLOR.red}${failed}${COLOR.reset}`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
