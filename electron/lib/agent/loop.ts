/**
 * Phase 4.0 — ReAct loop с approval gate.
 *
 * Цикл:
 *   1. Послать messages + tools → LLM
 *   2. Если LLM вернула tool_calls → для каждого:
 *      - policy=auto → execute сразу
 *      - policy=approval-required → emit approval-request, ждать UI-ответа
 *   3. Append tool results → вернуться в шаг 1
 *   4. Если LLM вернула финальный content (без tool_calls) → done
 *
 * Budget guards:
 *   - maxIterations (default 20) — защита от циклов
 *   - maxTokens (default 50_000) — защита бюджета
 */

import { randomUUID } from "crypto";
import {
  DEFAULT_BUDGET,
  type AgentBudget,
  type AgentEvent,
  type AgentMessage,
  type ToolCall,
} from "./types.js";
import { getTool, isPolicyAuto, listToolDefinitions, describeToolCall } from "./tools.js";

export interface AgentLoopArgs {
  messages: AgentMessage[];
  systemPrompt?: string;
  budget?: Partial<AgentBudget>;
  signal?: AbortSignal;
  emit: (e: AgentEvent) => void;
  /** Async resolver для approval-запросов. Возвращает true=approve, false=reject. */
  awaitApproval: (callId: string, toolName: string, args: unknown) => Promise<boolean>;
  /** LLM call с поддержкой tools. */
  llm: (args: {
    messages: AgentMessage[];
    tools: ReturnType<typeof listToolDefinitions>;
  }) => Promise<{
    content: string;
    toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
    usage?: { prompt: number; completion: number; total: number };
  }>;
}

export interface AgentLoopResult {
  finalAnswer: string;
  iterations: number;
  tokensUsed: number;
  toolHistory: Array<{ name: string; args: unknown; ok: boolean; durationMs: number }>;
  aborted: boolean;
  abortedReason?: string;
}

const SYSTEM_PROMPT_DEFAULT = `Ты — Forge Agent, надмозг приложения Bibliary.

Bibliary — это локальный self-hosted Electron-инструмент: библиотека книг
(PDF/EPUB/FB2/DOCX/TXT) → RAG-чат через LM Studio + Qdrant → fine-tuning
LoRA-адаптеров через WSL/Unsloth/Axolotl. Всё работает на железе пользователя,
никаких облачных сервисов нет.

Доступные tools:
  • search_help(query) — поиск ответа в встроенной справке Bibliary
    (FINE-TUNING, STATE-OF-PROJECT, ROADMAP). ОБЯЗАТЕЛЬНО используй когда
    пользователь спрашивает «как сделать X», «что такое Y» или непонятен
    рабочий процесс — это знание о самом приложении, не выдумывай.
  • recall_memory(query) — поиск в long-term памяти прошлых сессий.
    Используй когда пользователь говорит «как ты предлагал», «мы это уже
    обсуждали», или вопрос похож на типичный — может уже быть решение.
  • list_collections / search_collection — Qdrant (книги пользователя).
  • list_books — сканировать локальную папку с книгами.
  • bookhunter_search — найти книги в Project Gutenberg / Internet Archive
    / Open Library / arXiv (legal sources).
  • ingest_book — распарсить файл и положить в Qdrant. Требует approval.
  • delete_from_collection — удалить книгу из Qdrant. Требует approval.
  • write_role — изменить промпты T1/T2/T3 для Crystallizer. Требует approval.

Правила:
- Если вопрос про работу самого Bibliary (термины, шаги, фичи) — ВСЕГДА
  начни с search_help, не из общих знаний LLM. Знание о Bibliary живёт
  в KB и обновляется вместе с docs.
- Если задача требует действий — вызывай tools, не выдумывай результаты.
- Деструктивные tools (ingest/write/delete) ждут approval от пользователя
  — это нормально, продолжай работу с одобренными.
- Если tool упал — попробуй альтернативу или честно объясни проблему.
- Финальный ответ давай на русском, кратко и по делу. Цитируй источник
  (например, «по docs/FINE-TUNING.md, раздел "Pre-flight check"»),
  если ответ из search_help.
- Не вызывай tools, если ответ можно дать напрямую (приветствие, общее
  объяснение, не относящееся к Bibliary).`;

function parseToolArgs(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const budget = { ...DEFAULT_BUDGET, ...(args.budget ?? {}) };
  const tools = listToolDefinitions();
  const toolHistory: AgentLoopResult["toolHistory"] = [];

  let messages: AgentMessage[] = [
    { role: "system", content: args.systemPrompt ?? SYSTEM_PROMPT_DEFAULT },
    ...args.messages,
  ];
  let iterations = 0;
  let tokensUsed = 0;
  let finalAnswer = "";

  while (iterations < budget.maxIterations) {
    if (args.signal?.aborted) {
      args.emit({ type: "agent.aborted", reason: "user-cancel" });
      return { finalAnswer: "", iterations, tokensUsed, toolHistory, aborted: true, abortedReason: "user-cancel" };
    }
    if (tokensUsed > budget.maxTokens) {
      args.emit({ type: "agent.aborted", reason: `token-budget-exceeded (${tokensUsed} > ${budget.maxTokens})` });
      return {
        finalAnswer: finalAnswer || "[прервано: превышен лимит токенов]",
        iterations,
        tokensUsed,
        toolHistory,
        aborted: true,
        abortedReason: "token-budget",
      };
    }
    iterations++;
    args.emit({ type: "agent.budget", tokensUsed, iterations });

    let resp;
    try {
      resp = await args.llm({ messages, tools });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      args.emit({ type: "agent.error", error: `llm: ${msg}` });
      return { finalAnswer: "", iterations, tokensUsed, toolHistory, aborted: true, abortedReason: msg };
    }
    if (resp.usage) tokensUsed += resp.usage.total;

    /* Если есть tool_calls — оборачиваем assistant message с ними */
    if (resp.toolCalls && resp.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: resp.content || "",
        tool_calls: resp.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.argsJson },
        })),
      });
      if (resp.content) {
        args.emit({ type: "agent.thought", iteration: iterations, content: resp.content });
      }

      /* Исполняем каждый tool call */
      for (const tc of resp.toolCalls) {
        const callId = tc.id || randomUUID();
        const parsed = parseToolArgs(tc.argsJson);
        args.emit({ type: "agent.tool-call", callId, name: tc.name, args: parsed, iteration: iterations });

        const tool = getTool(tc.name);
        if (!tool) {
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify({ error: `unknown tool: ${tc.name}` }),
          });
          args.emit({ type: "agent.tool-result", callId, ok: false, preview: "unknown tool", durationMs: 0, iteration: iterations });
          continue;
        }

        /* Validate args */
        const argsParse = tool.argsSchema.safeParse(parsed);
        if (!argsParse.success) {
          const msg = argsParse.error.issues.slice(0, 3).map((i) => i.path.join(".") + ": " + i.message).join("; ");
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify({ error: `invalid args: ${msg}` }),
          });
          args.emit({ type: "agent.tool-result", callId, ok: false, preview: `invalid args: ${msg}`, durationMs: 0, iteration: iterations });
          continue;
        }

        /* Approval gate */
        if (!isPolicyAuto(tc.name)) {
          args.emit({
            type: "agent.approval-request",
            callId,
            toolName: tc.name,
            description: describeToolCall(tc.name, argsParse.data),
            args: argsParse.data,
          });
          const approved = await args.awaitApproval(callId, tc.name, argsParse.data);
          args.emit({ type: "agent.approval-response", callId, approved });
          if (!approved) {
            messages.push({
              role: "tool",
              tool_call_id: callId,
              content: JSON.stringify({ error: "user rejected this tool call" }),
            });
            args.emit({ type: "agent.tool-result", callId, ok: false, preview: "rejected by user", durationMs: 0, iteration: iterations });
            continue;
          }
        }

        /* Execute */
        const t0 = Date.now();
        try {
          const result = await tool.execute(argsParse.data, { signal: args.signal ?? new AbortController().signal, emit: args.emit });
          const durationMs = Date.now() - t0;
          const preview = JSON.stringify(result).slice(0, 200);
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify({ result }),
          });
          args.emit({ type: "agent.tool-result", callId, ok: true, preview, durationMs, iteration: iterations });
          toolHistory.push({ name: tc.name, args: argsParse.data, ok: true, durationMs });
        } catch (e) {
          const durationMs = Date.now() - t0;
          const msg = e instanceof Error ? e.message : String(e);
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify({ error: msg }),
          });
          args.emit({ type: "agent.tool-result", callId, ok: false, preview: msg, durationMs, iteration: iterations });
          toolHistory.push({ name: tc.name, args: argsParse.data, ok: false, durationMs });
        }
      }
      continue;
    }

    /* Нет tool_calls — финальный ответ */
    finalAnswer = resp.content;
    if (finalAnswer) {
      args.emit({ type: "agent.thought", iteration: iterations, content: finalAnswer });
    }
    break;
  }

  args.emit({ type: "agent.done", finalAnswer, iterations, tokensUsed });
  return { finalAnswer, iterations, tokensUsed, toolHistory, aborted: false };
}
