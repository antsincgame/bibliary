/**
 * Tests for agent loop budget guards and approval flow.
 * The LLM is fully injected via AgentLoopArgs.llm — no real LM Studio needed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../electron/lib/agent/loop.ts";
import type { AgentLoopArgs } from "../electron/lib/agent/loop.ts";
import type { AgentEvent } from "../electron/lib/agent/types.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeArgs(overrides: Partial<AgentLoopArgs> = {}): AgentLoopArgs {
  return {
    messages: [{ role: "user", content: "hello" }],
    emit: () => {},
    awaitApproval: async () => true,
    llm: async () => ({ content: "done", toolCalls: [] }),
    ...overrides,
  };
}

function collectEvents(args: Partial<AgentLoopArgs> = {}): { events: AgentEvent[]; args: AgentLoopArgs } {
  const events: AgentEvent[] = [];
  const fullArgs = makeArgs({ ...args, emit: (e) => events.push(e) });
  return { events, args: fullArgs };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("agent loop — budget guards", () => {
  test("happy path: finalAnswer returned, aborted=false", async () => {
    const { events, args } = collectEvents({
      llm: async () => ({ content: "42 is the answer", toolCalls: [] }),
    });

    const result = await runAgentLoop(args);

    assert.equal(result.aborted, false);
    assert.equal(result.finalAnswer, "42 is the answer");
    assert.equal(result.iterations, 1);
    assert(events.some((e) => e.type === "agent.done"));
  });

  test("maxIterations guard: loop terminates when iteration cap is reached", async () => {
    let calls = 0;
    const { events, args } = collectEvents({
      budget: { maxIterations: 3, maxTokens: 100_000 },
      llm: async () => {
        calls++;
        // Always return a tool call that forces another iteration.
        // Use unknown tool to avoid actual execution side effects.
        return {
          content: "",
          toolCalls: [{ id: `tc-${calls}`, name: "__nonexistent__", argsJson: "{}" }],
          usage: { prompt: 10, completion: 10, total: 20 },
        };
      },
    });

    const result = await runAgentLoop(args);

    assert.equal(result.aborted, false, "loop should exhaust naturally, not abort");
    assert.equal(result.iterations, 3, "should stop exactly at maxIterations");
    assert(events.some((e) => e.type === "agent.done"));
  });

  test("maxTokens guard: aborts when token budget exceeded", async () => {
    const { events, args } = collectEvents({
      budget: { maxIterations: 100, maxTokens: 50 },
      llm: async () => ({
        content: "",
        toolCalls: [{ id: "tc-1", name: "__nonexistent__", argsJson: "{}" }],
        usage: { prompt: 30, completion: 30, total: 60 },
      }),
    });

    const result = await runAgentLoop(args);

    assert.equal(result.aborted, true);
    assert.equal(result.abortedReason, "token-budget");
    assert(events.some((e) => e.type === "agent.aborted"));
  });

  test("AbortSignal: aborts immediately when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const { events, args } = collectEvents({ signal: controller.signal });
    const result = await runAgentLoop(args);

    assert.equal(result.aborted, true);
    assert.equal(result.abortedReason, "user-cancel");
    assert.equal(result.iterations, 0);
    assert(events.some((e) => e.type === "agent.aborted"));
  });

  test("budget events emitted each iteration", async () => {
    let calls = 0;
    const { events, args } = collectEvents({
      budget: { maxIterations: 3, maxTokens: 100_000 },
      llm: async () => {
        calls++;
        if (calls < 3) {
          return {
            content: "",
            toolCalls: [{ id: `tc-${calls}`, name: "__nonexistent__", argsJson: "{}" }],
            usage: { prompt: 5, completion: 5, total: 10 },
          };
        }
        return { content: "final", toolCalls: [], usage: { prompt: 5, completion: 5, total: 10 } };
      },
    });

    await runAgentLoop(args);

    const budgetEvents = events.filter((e) => e.type === "agent.budget");
    assert.ok(budgetEvents.length >= 2, "should emit budget event each iteration");
  });

  test("LLM error: aborts with error reason", async () => {
    const { events, args } = collectEvents({
      llm: async () => { throw new Error("connection refused"); },
    });

    const result = await runAgentLoop(args);

    assert.equal(result.aborted, true);
    assert.match(result.abortedReason ?? "", /connection refused/);
    assert(events.some((e) => e.type === "agent.error"));
  });
});

describe("agent loop — approval flow", () => {
  test("unknown tool: rejected gracefully without crash", async () => {
    const { args } = collectEvents({
      llm: async () => ({
        content: "done",
        toolCalls: [{ id: "tc-1", name: "nonexistent_tool", argsJson: "{}" }],
      }),
    });

    const result = await runAgentLoop(args);
    assert.equal(result.aborted, false);
  });

  test("approval rejected: tool-result has rejection error, loop continues", async () => {
    const events: AgentEvent[] = [];
    let llmCalls = 0;

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "delete my collection" }],
      emit: (e) => events.push(e),
      awaitApproval: async () => false,
      llm: async () => {
        llmCalls++;
        if (llmCalls === 1) {
          return {
            content: "",
            toolCalls: [{
              id: "tc-del",
              name: "delete_from_collection",
              argsJson: JSON.stringify({ collection: "books", bookSourcePath: "/library/book.epub" }),
            }],
          };
        }
        return { content: "OK, not deleting.", toolCalls: [] };
      },
    });

    assert.equal(result.aborted, false);
    assert.equal(result.finalAnswer, "OK, not deleting.");

    const approvalRequests = events.filter((e) => e.type === "agent.approval-request");
    const approvalResponses = events.filter(
      (e) => e.type === "agent.approval-response" && !(e as { approved: boolean }).approved
    );
    assert.ok(approvalRequests.length >= 1, "should emit approval-request");
    assert.ok(approvalResponses.length >= 1, "should emit approval-response with approved=false");
  });

  test("approval approved: tool-result executed, loop continues normally", async () => {
    const events: AgentEvent[] = [];
    let llmCalls = 0;

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "delete my collection" }],
      emit: (e) => events.push(e),
      awaitApproval: async () => true,
      llm: async () => {
        llmCalls++;
        if (llmCalls === 1) {
          return {
            content: "",
            toolCalls: [{
              id: "tc-del",
              name: "delete_from_collection",
              argsJson: JSON.stringify({ collection: "books", bookSourcePath: "/library/book.epub" }),
            }],
          };
        }
        return { content: "Deleted successfully.", toolCalls: [] };
      },
    });

    assert.equal(result.aborted, false);
    const approvalResponses = events.filter(
      (e) => e.type === "agent.approval-response" && (e as { approved: boolean }).approved
    );
    assert.ok(approvalResponses.length >= 1, "should emit approval-response with approved=true");
  });
});
