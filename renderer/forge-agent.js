// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { metatronCube, svgDataUrl } from "./components/sacred-geometry.js";
import { buildModelSelect } from "./components/model-select.js";
import { AGENT_HISTORY_CAP } from "./components/agent-constants.js";

/**
 * Phase 4.0 — Forge Chat Agent UI.
 * Real LLM (LM Studio) через window.api.agent.start. Никаких mock.
 *
 * Поток:
 *   1. На mount: загружаем list of loaded models (lmstudio:list-loaded)
 *   2. Пользователь пишет prompt + выбирает модель → agent:start
 *   3. agent:event push events рендерятся inline:
 *      - thought    → серый блок мысли
 *      - tool-call  → жёлтый collapsible "▶ tool_name(args)"
 *      - tool-result→ прикрепляется к tool-call с preview
 *      - approval-request → модалка Apply/Reject
 *      - done       → финальный ответ
 *   4. Stop button → agent:cancel
 */

const STATE = {
  /** @type {Array<{role: string, content: string, tools?: Array<{callId: string, name: string, args: unknown, result?: unknown, ok?: boolean, durationMs?: number, expanded?: boolean}>}>} */
  chatHistory: [],
  /** @type {string | null} */
  currentAgentId: null,
  /** Активный pending approval — сразу один максимум */
  /** @type {{ callId: string, toolName: string, description: string, args: unknown } | null} */
  pendingApproval: null,
  /** Live activity (последние ~50 событий для timeline) */
  /** @type {Array<{ts: number, type: string, summary: string}>} */
  activity: [],
  busy: false,
};

let unsubEvents = null;
/** Активный экземпляр model-select для агента (создаётся в setupAgentModelSelector). */
let agentModelSelect = /** @type {ReturnType<typeof buildModelSelect> | null} */ (null);

/** Подсказки для подбора tool-capable модели по умолчанию. */
const AGENT_TOOL_HINTS = ["qwen3.6", "qwen3-coder", "qwen3.5", "mistral-small", "qwen2.5-coder"];

/**
 * Максимум сообщений в STATE.chatHistory. Cap нужен по двум причинам:
 *   (1) UI memory: каждое сообщение хранит content + tool-вызовы с args+result;
 *       при долгом диалоге это растёт без границ.
 *   (2) IPC payload: с B1 (multiturn) мы шлём историю в backend, агент
 *       получает её как контекст — чем длиннее, тем больше токенов LLM.
 *
 * 50 сообщений ≈ 25 user/assistant пар — покрывает реалистичный диалог,
 * но не даёт расти бесконечно. FIFO-eviction. Константа вынесена в
 * components/agent-constants.js — там же live-ссылка на backend-зеркало
 * (DEFAULT_HISTORY_CAP в electron/lib/agent/history-sanitize.ts).
 */
/* AGENT_HISTORY_CAP импортируется из ./components/agent-constants.js */

function trimAgentHistory() {
  if (STATE.chatHistory.length > AGENT_HISTORY_CAP) {
    STATE.chatHistory = STATE.chatHistory.slice(-AGENT_HISTORY_CAP);
  }
}

/**
 * Готовит историю для отправки в agent:start. Берёт последние N сообщений,
 * отфильтровывает по role, оставляет только text content (без tool-блоков —
 * backend не нужно знать про conversation-level tool history, ему важна
 * только семантика разговора).
 */
function buildHistoryForBackend() {
  const out = [];
  for (const m of STATE.chatHistory.slice(-AGENT_HISTORY_CAP)) {
    if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0) {
      out.push({ role: m.role, content: m.content });
    }
  }
  /* Последнее сообщение — это только что добавленный user prompt; его шлём
     отдельным полем userMessage. Здесь убираем его, чтобы не дублировать. */
  if (out.length > 0 && out[out.length - 1].role === "user") {
    out.pop();
  }
  return out;
}

function fmtMs(ms) {
  if (!ms || ms < 1000) return `${ms ?? "?"}ms`;
  return (ms / 1000).toFixed(1) + "s";
}

function fmtJson(v, max = 200) {
  try {
    const s = JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(v).slice(0, max);
  }
}

/**
 * Монтирует общий model-select внутри toolbar-контейнера .agent-model-wrap.
 * Сохраняет инстанс в module-level agentModelSelect для sendPrompt и Refresh.
 */
function setupAgentModelSelector(root) {
  const wrap = root.querySelector(".agent-model-wrap");
  if (!wrap) return;
  clear(wrap);
  agentModelSelect = buildModelSelect({
    role: "agent",
    label: t("agent.model.label"),
    showContext: true,
    selectId: "agent-model-select",
    selectClass: "agent-model-select",
    labelClass: "agent-model-label",
    wrapClass: "agent-model-inner",
    hints: AGENT_TOOL_HINTS,
  });
  const refreshBtn = el(
    "button",
    {
      class: "agent-model-refresh",
      type: "button",
      title: t("agent.model.refresh"),
      onclick: async () => {
        await agentModelSelect?.refresh();
      },
    },
    "↻"
  );
  wrap.append(agentModelSelect.wrap, refreshBtn);
}

function renderActivity(root) {
  const wrap = root.querySelector(".agent-activity-list");
  if (!wrap) return;
  clear(wrap);
  if (STATE.activity.length === 0) {
    wrap.appendChild(el("div", { class: "agent-activity-empty" }, t("agent.activity.empty")));
    return;
  }
  for (const ev of STATE.activity.slice(-50).reverse()) {
    const time = new Date(ev.ts).toLocaleTimeString();
    wrap.appendChild(
      el("div", { class: `agent-activity-row agent-activity-${ev.type.replace(/\./g, "-")}` }, [
        el("span", { class: "agent-activity-time" }, time),
        el("span", { class: "agent-activity-type" }, ev.type),
        el("span", { class: "agent-activity-summary" }, ev.summary),
      ])
    );
  }
}

function pushActivity(type, summary) {
  STATE.activity.push({ ts: Date.now(), type, summary: String(summary).slice(0, 240) });
  if (STATE.activity.length > 200) STATE.activity = STATE.activity.slice(-100);
}

function lastAssistantMessage() {
  for (let i = STATE.chatHistory.length - 1; i >= 0; i--) {
    if (STATE.chatHistory[i].role === "assistant") return STATE.chatHistory[i];
  }
  return null;
}

function renderChat(root) {
  const list = root.querySelector(".agent-chat-list");
  if (!list) return;
  clear(list);
  for (const msg of STATE.chatHistory) {
    const block = el("div", { class: `agent-msg agent-msg-${msg.role}` });
    block.appendChild(el("div", { class: "agent-msg-role" }, msg.role.toUpperCase()));
    if (msg.content) {
      block.appendChild(el("div", { class: "agent-msg-content" }, msg.content));
    }
    if (msg.tools && msg.tools.length > 0) {
      const toolsWrap = el("div", { class: "agent-msg-tools" });
      for (const tc of msg.tools) {
        const head = el(
          "div",
          {
            class: `agent-tool-head agent-tool-${tc.ok === undefined ? "pending" : tc.ok ? "ok" : "fail"}`,
            onclick: () => {
              tc.expanded = !tc.expanded;
              renderChat(root);
            },
          },
          [
            el("span", { class: "agent-tool-arrow" }, tc.expanded ? "▼" : "▶"),
            el("span", { class: "agent-tool-name" }, tc.name),
            el("span", { class: "agent-tool-args" }, fmtJson(tc.args, 80)),
            tc.durationMs !== undefined ? el("span", { class: "agent-tool-duration" }, fmtMs(tc.durationMs)) : null,
          ]
        );
        const card = el("div", { class: "agent-tool-card" }, [head]);
        if (tc.expanded) {
          if (tc.args !== undefined) {
            card.appendChild(
              el("pre", { class: "agent-tool-body agent-tool-body-args" }, JSON.stringify(tc.args, null, 2))
            );
          }
          if (tc.result !== undefined) {
            card.appendChild(
              el("pre", { class: "agent-tool-body agent-tool-body-result" }, JSON.stringify(tc.result, null, 2))
            );
          }
        }
        toolsWrap.appendChild(card);
      }
      block.appendChild(toolsWrap);
    }
    list.appendChild(block);
  }
  list.scrollTop = list.scrollHeight;
}

function renderApproval(root) {
  const wrap = root.querySelector(".agent-approval-area");
  if (!wrap) return;
  clear(wrap);
  if (!STATE.pendingApproval) return;
  const p = STATE.pendingApproval;
  const card = el("div", { class: "agent-approval-card" }, [
    el("div", { class: "agent-approval-icon" }, "⚠"),
    el("div", { class: "agent-approval-body" }, [
      el("div", { class: "agent-approval-title" }, t("agent.approval.title")),
      el("div", { class: "agent-approval-desc" }, p.description),
      el("pre", { class: "agent-approval-args" }, JSON.stringify(p.args, null, 2)),
    ]),
    el("div", { class: "agent-approval-actions" }, [
      el(
        "button",
        {
          class: "agent-btn agent-btn-accent",
          type: "button",
          onclick: async () => {
            const callId = p.callId;
            STATE.pendingApproval = null;
            renderApproval(root);
            try {
              await window.api.agent.approve(callId, true);
            } catch (e) {
              pushActivity("approval.error", e instanceof Error ? e.message : String(e));
              renderActivity(root);
            }
          },
        },
        t("agent.approval.apply")
      ),
      el(
        "button",
        {
          class: "agent-btn",
          type: "button",
          onclick: async () => {
            const callId = p.callId;
            STATE.pendingApproval = null;
            renderApproval(root);
            try {
              await window.api.agent.approve(callId, false);
            } catch (e) {
              pushActivity("approval.error", e instanceof Error ? e.message : String(e));
              renderActivity(root);
            }
          },
        },
        t("agent.approval.reject")
      ),
    ]),
  ]);
  wrap.appendChild(card);
}

function setBusy(root, busy) {
  STATE.busy = busy;
  const send = root.querySelector("#agent-send");
  const stop = root.querySelector("#agent-stop");
  const input = root.querySelector("#agent-input");
  if (send) send.disabled = busy;
  if (stop) stop.disabled = !busy;
  if (input) input.disabled = busy;
}

/* ───── handleAgentEvent: type handlers (dispatcher pattern) ───── */

function handleThoughtEvent(root, payload) {
  const last = lastAssistantMessage();
  if (last && (last.tools?.length ?? 0) === 0 && !last.content) {
    last.content = String(payload.content ?? "");
  } else {
    STATE.chatHistory.push({ role: "assistant", content: String(payload.content ?? ""), tools: [] });
  }
  pushActivity("thought", String(payload.content ?? "").slice(0, 80));
  renderChat(root);
}

function handleToolCallEvent(root, payload) {
  let last = lastAssistantMessage();
  if (!last || !last.tools) {
    last = { role: "assistant", content: "", tools: [] };
    STATE.chatHistory.push(last);
  }
  last.tools.push({
    callId: String(payload.callId),
    name: String(payload.name),
    args: payload.args,
    expanded: false,
  });
  pushActivity("tool-call", `${payload.name}(${fmtJson(payload.args, 60)})`);
  renderChat(root);
}

function handleToolResultEvent(root, payload) {
  const last = lastAssistantMessage();
  if (last?.tools) {
    const tc = last.tools.find((x) => x.callId === payload.callId);
    if (tc) {
      try {
        tc.result = JSON.parse(String(payload.preview ?? "null"));
      } catch {
        tc.result = String(payload.preview ?? "");
      }
      tc.ok = Boolean(payload.ok);
      tc.durationMs = Number(payload.durationMs ?? 0);
    }
  }
  pushActivity("tool-result", `ok=${payload.ok} ${fmtMs(payload.durationMs)}`);
  renderChat(root);
}

function handleApprovalRequestEvent(root, payload) {
  STATE.pendingApproval = {
    callId: String(payload.callId),
    toolName: String(payload.toolName),
    description: String(payload.description),
    args: payload.args,
  };
  pushActivity("approval", `${payload.toolName}: ${payload.description}`);
  renderApproval(root);
  renderActivity(root);
}

function handleApprovalResponseEvent(root, payload) {
  pushActivity("approval-resp", `approved=${payload.approved}`);
  renderActivity(root);
}

function handleDoneEvent(root, payload) {
  pushActivity("done", `iter=${payload.iterations} tokens=${payload.tokensUsed}`);
  renderActivity(root);
  setBusy(root, false);
}

function handleAbortedEvent(root, payload) {
  pushActivity("aborted", String(payload.reason ?? ""));
  renderActivity(root);
  setBusy(root, false);
}

function handleErrorEvent(root, payload) {
  STATE.chatHistory.push({
    role: "assistant",
    content: `⚠ Ошибка: ${payload.error}`,
    tools: [],
  });
  pushActivity("error", String(payload.error ?? ""));
  renderActivity(root);
  renderChat(root);
  setBusy(root, false);
}

function handleBudgetEvent(root, payload) {
  pushActivity("budget", `tokens=${payload.tokensUsed} iters=${payload.iterations}`);
  renderActivity(root);
}

const AGENT_EVENT_HANDLERS = {
  "agent.thought": handleThoughtEvent,
  "agent.tool-call": handleToolCallEvent,
  "agent.tool-result": handleToolResultEvent,
  "agent.approval-request": handleApprovalRequestEvent,
  "agent.approval-response": handleApprovalResponseEvent,
  "agent.done": handleDoneEvent,
  "agent.aborted": handleAbortedEvent,
  "agent.error": handleErrorEvent,
  "agent.budget": handleBudgetEvent,
};

function handleAgentEvent(root, payload) {
  /* Перехват agentId из первого события — это позволяет cancel работать ДО завершения invoke */
  if (payload.agentId && !STATE.currentAgentId) {
    STATE.currentAgentId = payload.agentId;
  }
  const handler = AGENT_EVENT_HANDLERS[payload.type];
  if (handler) handler(root, payload);
}

async function sendPrompt(root) {
  if (STATE.busy) return;
  const input = /** @type {HTMLTextAreaElement} */ (root.querySelector("#agent-input"));
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const model = agentModelSelect?.getValue() ?? "";
  if (!model) {
    alert(t("agent.alert.noModel"));
    return;
  }
  STATE.chatHistory.push({ role: "user", content: text });
  trimAgentHistory();
  renderChat(root);
  input.value = "";
  setBusy(root, true);
  /* Выставляем agentId ДО await, чтобы Stop работал во время выполнения.
   * Используем onEvent для получения agentId из первого события. */
  try {
    const resultPromise = window.api.agent.start({
      userMessage: text,
      model,
      budget: { maxIterations: 12, maxTokens: 30_000 },
      history: buildHistoryForBackend(),
    });
    /* agentId приходит в onEvent-payload; до этого — слушаем первое событие */
    const result = await resultPromise;
    STATE.currentAgentId = result.agentId;
    const last = lastAssistantMessage();
    if (result.finalAnswer && (!last || (last.content !== result.finalAnswer && (last.tools?.length ?? 0) > 0))) {
      STATE.chatHistory.push({ role: "assistant", content: result.finalAnswer, tools: [] });
      trimAgentHistory();
      renderChat(root);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    STATE.chatHistory.push({ role: "assistant", content: `⚠ ${msg}`, tools: [] });
    renderChat(root);
  } finally {
    STATE.currentAgentId = null;
    setBusy(root, false);
  }
}

async function stopAgent(root) {
  if (!STATE.currentAgentId) return;
  try {
    await window.api.agent.cancel(STATE.currentAgentId);
    pushActivity("aborted", t("agent.stopByUser"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushActivity("error", `${t("agent.stopFailed")}: ${msg}`);
  }
  STATE.pendingApproval = null;
  renderApproval(root);
  renderActivity(root);
  setBusy(root, false);
}

function buildAgentHero() {
  const heroPattern = svgDataUrl(metatronCube({ size: 380, opacity: 0.2, color: "#ffd700" }));
  return el(
    "div",
    {
      class: "hero-neon agent-hero",
      style: `--hero-pattern: url('${heroPattern}');`,
    },
    [
      el("div", { class: "hero-neon-title" }, t("agent.hero.title")),
      el("div", { class: "hero-neon-sub" }, t("agent.hero.sub")),
    ]
  );
}

function buildAgentToolbar(root) {
  return el("div", { class: "agent-toolbar agent-toolbar-neon" }, [
    el("div", { class: "agent-model-wrap" }),
    el(
      "button",
      {
        class: "neon-btn",
        type: "button",
        id: "agent-stop",
        disabled: "true",
        onclick: () => stopAgent(root),
      },
      t("agent.btn.stop")
    ),
  ]);
}

function buildAgentChatWrap(root) {
  return el("div", { class: "agent-chat-wrap sacred-card" }, [
    el("div", { class: "agent-chat-list" }),
    el("div", { class: "agent-approval-area" }),
    el("div", { class: "agent-input-wrap" }, [
      el("textarea", {
        id: "agent-input",
        class: "agent-input",
        placeholder: t("agent.input.placeholder"),
        rows: "3",
      }),
      el(
        "button",
        {
          class: "neon-btn neon-btn-primary",
          type: "button",
          id: "agent-send",
          onclick: () => sendPrompt(root),
        },
        t("agent.btn.send")
      ),
    ]),
  ]);
}

function buildAgentSidebar() {
  return el("div", { class: "agent-sidebar sacred-card" }, [
    el("div", { class: "agent-sidebar-title neon-subheading" }, t("agent.activity.title")),
    el("div", { class: "agent-activity-list" }),
  ]);
}

function bindAgentInputHotkeys(root) {
  const inputEl = root.querySelector("#agent-input");
  if (!inputEl) return;
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendPrompt(root);
    }
  });
}

function subscribeAgentEvents(root) {
  if (unsubEvents) unsubEvents();
  unsubEvents = window.api.agent.onEvent((payload) => handleAgentEvent(root, payload));
}

export function mountAgent(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  root.appendChild(buildAgentHero());
  root.appendChild(buildAgentToolbar(root));
  root.appendChild(el("div", { class: "agent-layout" }, [
    buildAgentChatWrap(root),
    buildAgentSidebar(),
  ]));

  bindAgentInputHotkeys(root);
  setupAgentModelSelector(root);
  renderChat(root);
  renderActivity(root);
  subscribeAgentEvents(root);
}

export function isAgentBusy() {
  return STATE.busy;
}
