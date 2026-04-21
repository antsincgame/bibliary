/**
 * Phase 4.0 — Forge Chat Agent.
 * Контракты для tools, ReAct loop, approval-policy, audit log.
 */

import { z } from "zod";

export type ToolPolicy = "auto" | "approval-required";

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  policy: ToolPolicy;
  argsSchema: z.ZodType<TArgs>;
  /** Краткое summary для approval-card в UI. */
  describeCall?: (args: TArgs) => string;
  execute: (args: TArgs, ctx: ToolContext) => Promise<TResult>;
}

export interface ToolContext {
  signal: AbortSignal;
  /** Эмиттер событий для UI (alchemy log, approval-request). */
  emit: (e: AgentEvent) => void;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export type AgentEvent =
  | { type: "agent.thought"; iteration: number; content: string }
  | { type: "agent.tool-call"; callId: string; name: string; args: unknown; iteration: number }
  | { type: "agent.tool-result"; callId: string; ok: boolean; preview: string; durationMs: number; iteration: number }
  | { type: "agent.approval-request"; callId: string; toolName: string; description: string; args: unknown }
  | { type: "agent.approval-response"; callId: string; approved: boolean; reason?: string }
  | { type: "agent.budget"; tokensUsed: number; iterations: number }
  | { type: "agent.done"; finalAnswer: string; iterations: number; tokensUsed: number }
  | { type: "agent.aborted"; reason: string }
  | { type: "agent.error"; error: string };

export interface AgentBudget {
  maxIterations: number;
  maxTokens: number;
}

export const DEFAULT_BUDGET: AgentBudget = {
  maxIterations: 20,
  maxTokens: 50_000,
};

/** OpenAI-compatible tools-определение для отправки в LM Studio. */
export interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}
