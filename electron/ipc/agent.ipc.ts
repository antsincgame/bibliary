/**
 * Phase 4.0 — Forge Chat Agent IPC.
 *
 * Каналы:
 *   - agent:start    → запустить ReAct loop с user-message
 *   - agent:approve  → resolve approval-promise (true/false) для destructive tool
 *   - agent:cancel   → abort активный loop
 *
 * Push events: agent:event → AgentEvent (thought, tool-call, tool-result,
 *   approval-request, done, error).
 *
 * LM Studio bridge — через `chatWithTools` из `lmstudio-client.ts`
 * (единая точка входа на /v1/chat/completions).
 */

import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import {
  runAgentLoop,
  type AgentEvent,
  type AgentLoopResult,
  type AgentMessage,
  type OpenAiToolDefinition,
} from "../lib/agent/index.js";
import { chatWithToolsAndPolicy, type ToolMessage } from "../lmstudio-client.js";

const activeAgents = new Map<string, AbortController>();
/* pendingApprovals хранит agentId, чтобы cancel одного агента не уронил
   approvals соседнего. Старая реализация чистила Map целиком — закрывает
   AUDIT HIGH-3 (cross-agent approval rejection при параллельных сессиях). */
const pendingApprovals = new Map<string, { resolve: (approved: boolean) => void; agentId: string }>();

function rejectApprovalsForAgent(agentId: string): void {
  for (const [callId, p] of pendingApprovals.entries()) {
    if (p.agentId === agentId) {
      p.resolve(false);
      pendingApprovals.delete(callId);
    }
  }
}

export function abortAllAgents(reason: string): void {
  for (const [id, ctrl] of activeAgents.entries()) {
    ctrl.abort(reason);
    activeAgents.delete(id);
  }
  /* shutdown — единственный случай когда корректно убить все approvals разом */
  for (const [, p] of pendingApprovals.entries()) p.resolve(false);
  pendingApprovals.clear();
}

export function registerAgentIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    "agent:start",
    async (
      _e,
      args: {
        userMessage: string;
        model: string;
        budget?: { maxIterations?: number; maxTokens?: number };
      }
    ): Promise<AgentLoopResult & { agentId: string }> => {
      if (!args || typeof args.userMessage !== "string" || args.userMessage.trim().length === 0) {
        throw new Error("userMessage required");
      }
      if (typeof args.model !== "string" || args.model.trim().length === 0) {
        throw new Error("model required (передайте имя загруженной в LM Studio модели)");
      }
      const agentId = randomUUID();
      const ctrl = new AbortController();
      activeAgents.set(agentId, ctrl);
      const win = getMainWindow();
      const model = args.model;

      const emit = (e: AgentEvent): void => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("agent:event", { agentId, ...e });
        }
      };

      try {
        const result = await runAgentLoop({
          messages: [{ role: "user", content: args.userMessage }],
          budget: args.budget,
          signal: ctrl.signal,
          emit,
          awaitApproval: (callId) =>
            new Promise<boolean>((resolve) => {
              pendingApprovals.set(callId, { resolve, agentId });
            }),
          llm: async ({ messages, tools }) => {
            const resp = await chatWithToolsAndPolicy({
              model,
              messages: messages as ToolMessage[],
              tools: tools as OpenAiToolDefinition[],
              toolChoice: "auto",
              sampling: { temperature: 0.5, top_p: 0.9, max_tokens: 4096 },
              signal: ctrl.signal,
            }, { externalSignal: ctrl.signal });
            return {
              content: resp.content,
              toolCalls: resp.toolCalls,
              usage: resp.usage,
            };
          },
        });
        return { ...result, agentId };
      } finally {
        activeAgents.delete(agentId);
      }
    }
  );

  ipcMain.handle("agent:approve", async (_e, args: { callId: string; approved: boolean }): Promise<boolean> => {
    if (!args || typeof args.callId !== "string") return false;
    const pending = pendingApprovals.get(args.callId);
    if (!pending) return false;
    pendingApprovals.delete(args.callId);
    pending.resolve(args.approved === true);
    return true;
  });

  ipcMain.handle("agent:cancel", async (_e, agentId: string): Promise<boolean> => {
    const ctrl = activeAgents.get(agentId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeAgents.delete(agentId);
    /* Резолвим только approvals ЭТОГО агента — соседние сессии не страдают */
    rejectApprovalsForAgent(agentId);
    return true;
  });
}
