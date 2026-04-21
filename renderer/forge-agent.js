// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { metatronCube, svgDataUrl } from "./components/sacred-geometry.js";

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

/** @typedef {{ identifier: string, modelKey: string, contextLength?: number }} LoadedModel */

const STATE = {
  /** @type {LoadedModel[]} */
  loadedModels: [],
  /** @type {string} */
  selectedModel: "",
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

const TOOL_CAPABLE_HINTS = ["qwen3.6", "qwen3-coder", "qwen3.5", "mistral-small", "qwen2.5-coder"];

function pickDefaultModel(models) {
  for (const hint of TOOL_CAPABLE_HINTS) {
    const m = models.find((x) => x.modelKey.toLowerCase().includes(hint));
    if (m) return m.modelKey;
  }
  return models[0]?.modelKey ?? "";
}

async function loadModels() {
  try {
    /** @type {LoadedModel[]} */
    const list = await window.api.lmstudio.listLoaded();
    STATE.loadedModels = Array.isArray(list) ? list : [];
    if (!STATE.selectedModel || !STATE.loadedModels.find((m) => m.modelKey === STATE.selectedModel)) {
      STATE.selectedModel = pickDefaultModel(STATE.loadedModels);
    }
  } catch {
    STATE.loadedModels = [];
    STATE.selectedModel = "";
  }
}

function renderModelSelector(root) {
  const wrap = root.querySelector(".agent-model-wrap");
  if (!wrap) return;
  clear(wrap);
  const label = el("label", { class: "agent-model-label" }, t("agent.model.label"));
  const sel = el("select", { class: "agent-model-select", id: "agent-model-select" });
  if (STATE.loadedModels.length === 0) {
    sel.appendChild(el("option", { value: "" }, t("agent.model.noLoaded")));
    sel.disabled = true;
  } else {
    for (const m of STATE.loadedModels) {
      const opt = el("option", { value: m.modelKey }, m.modelKey + (m.contextLength ? ` (${m.contextLength})` : ""));
      if (m.modelKey === STATE.selectedModel) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  sel.addEventListener("change", () => {
    STATE.selectedModel = sel.value;
  });
  const refresh = el(
    "button",
    {
      class: "agent-model-refresh",
      type: "button",
      title: t("agent.model.refresh"),
      onclick: async () => {
        await loadModels();
        renderModelSelector(root);
      },
    },
    "↻"
  );
  wrap.append(label, sel, refresh);
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

function handleAgentEvent(root, payload) {
  /* Перехват agentId из первого события — это позволяет cancel работать ДО завершения invoke */
  if (payload.agentId && !STATE.currentAgentId) {
    STATE.currentAgentId = payload.agentId;
  }
  const eventType = payload.type;
  if (eventType === "agent.thought") {
    const last = lastAssistantMessage();
    if (last && (last.tools?.length ?? 0) === 0 && !last.content) {
      last.content = String(payload.content ?? "");
    } else {
      STATE.chatHistory.push({ role: "assistant", content: String(payload.content ?? ""), tools: [] });
    }
    pushActivity("thought", String(payload.content ?? "").slice(0, 80));
    renderChat(root);
    return;
  }
  if (eventType === "agent.tool-call") {
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
    return;
  }
  if (eventType === "agent.tool-result") {
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
    return;
  }
  if (eventType === "agent.approval-request") {
    STATE.pendingApproval = {
      callId: String(payload.callId),
      toolName: String(payload.toolName),
      description: String(payload.description),
      args: payload.args,
    };
    pushActivity("approval", `${payload.toolName}: ${payload.description}`);
    renderApproval(root);
    renderActivity(root);
    return;
  }
  if (eventType === "agent.approval-response") {
    pushActivity("approval-resp", `approved=${payload.approved}`);
    renderActivity(root);
    return;
  }
  if (eventType === "agent.done") {
    pushActivity("done", `iter=${payload.iterations} tokens=${payload.tokensUsed}`);
    renderActivity(root);
    setBusy(root, false);
    return;
  }
  if (eventType === "agent.aborted") {
    pushActivity("aborted", String(payload.reason ?? ""));
    renderActivity(root);
    setBusy(root, false);
    return;
  }
  if (eventType === "agent.error") {
    STATE.chatHistory.push({
      role: "assistant",
      content: `⚠ Ошибка: ${payload.error}`,
      tools: [],
    });
    pushActivity("error", String(payload.error ?? ""));
    renderActivity(root);
    renderChat(root);
    setBusy(root, false);
    return;
  }
  if (eventType === "agent.budget") {
    pushActivity("budget", `tokens=${payload.tokensUsed} iters=${payload.iterations}`);
    renderActivity(root);
    return;
  }
}

async function sendPrompt(root) {
  if (STATE.busy) return;
  const input = /** @type {HTMLTextAreaElement} */ (root.querySelector("#agent-input"));
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!STATE.selectedModel) {
    alert(t("agent.alert.noModel"));
    return;
  }
  STATE.chatHistory.push({ role: "user", content: text });
  renderChat(root);
  input.value = "";
  setBusy(root, true);
  /* Выставляем agentId ДО await, чтобы Stop работал во время выполнения.
   * Используем onEvent для получения agentId из первого события. */
  try {
    const resultPromise = window.api.agent.start({
      userMessage: text,
      model: STATE.selectedModel,
      budget: { maxIterations: 12, maxTokens: 30_000 },
    });
    /* agentId приходит в onEvent-payload; до этого — слушаем первое событие */
    const result = await resultPromise;
    STATE.currentAgentId = result.agentId;
    const last = lastAssistantMessage();
    if (result.finalAnswer && (!last || (last.content !== result.finalAnswer && (last.tools?.length ?? 0) > 0))) {
      STATE.chatHistory.push({ role: "assistant", content: result.finalAnswer, tools: [] });
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

export function mountAgent(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  /* Hero с sacred geometry — metatron-куб золотом на фоне */
  const heroPattern = svgDataUrl(metatronCube({ size: 380, opacity: 0.2, color: "#ffd700" }));
  const hero = el(
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

  const toolbar = el("div", { class: "agent-toolbar agent-toolbar-neon" }, [
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

  const chatWrap = el("div", { class: "agent-chat-wrap sacred-card" }, [
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

  const sidebar = el("div", { class: "agent-sidebar sacred-card" }, [
    el("div", { class: "agent-sidebar-title neon-subheading" }, t("agent.activity.title")),
    el("div", { class: "agent-activity-list" }),
  ]);

  const layout = el("div", { class: "agent-layout" }, [chatWrap, sidebar]);

  root.appendChild(hero);
  root.appendChild(toolbar);
  root.appendChild(layout);

  const inputEl = root.querySelector("#agent-input");
  if (inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendPrompt(root);
      }
    });
  }

  loadModels().then(() => renderModelSelector(root));
  renderChat(root);
  renderActivity(root);

  if (unsubEvents) unsubEvents();
  unsubEvents = window.api.agent.onEvent((payload) => handleAgentEvent(root, payload));
}

export function isAgentBusy() {
  return STATE.busy;
}
