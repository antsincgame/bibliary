// @ts-check
import { t } from "./i18n.js";
import { buildContextSlider } from "./components/context-slider.js";

let SPIN_DURATION_MS = 600;
const TEXTAREA_MAX_HEIGHT = 120;
let TOAST_TTL_MS = 5000;

(async () => {
  try {
    const prefs = await window.api?.preferences?.getAll();
    if (!prefs) return;
    if (typeof prefs.spinDurationMs === "number") SPIN_DURATION_MS = prefs.spinDurationMs;
    if (typeof prefs.toastTtlMs === "number") TOAST_TTL_MS = prefs.toastTtlMs;
  } catch { /* defaults */ }
})();

/** @type {Array<{role: string, content: string}>} */
const history = [];
let isLoading = false;
let compareMode = false;

/** @param {string} id @returns {HTMLElement} */
function getEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

/** @param {string} md */
function renderMarkdown(md) {
  if (typeof window.marked !== "undefined" && window.marked.parse) {
    return window.marked.parse(md, { breaks: true });
  }
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

/** @param {HTMLDivElement} chatArea */
function removeWelcome(chatArea) {
  const welcome = chatArea.querySelector(".welcome");
  if (welcome) welcome.remove();
}

/**
 * @param {HTMLDivElement} chatArea
 * @param {string} className
 * @param {string} content
 * @param {boolean} [isMarkdown]
 */
function appendChatBubble(chatArea, className, content, isMarkdown = false) {
  removeWelcome(chatArea);
  const div = document.createElement("div");
  div.className = className;
  if (isMarkdown) div.innerHTML = renderMarkdown(content);
  else div.textContent = content;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

/** @param {HTMLSelectElement} select @param {Array<string|{id:string}>} items */
function populateSelect(select, items) {
  select.innerHTML = "";
  if (items.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("chat.none");
    select.appendChild(opt);
    return;
  }
  items.forEach((item) => {
    const opt = document.createElement("option");
    const value = typeof item === "string" ? item : item.id;
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  });
}

/** @param {HTMLButtonElement} btn @param {() => Promise<void>} action */
async function withSpin(btn, action) {
  btn.classList.add("spinning");
  try {
    await action();
  } finally {
    setTimeout(() => btn.classList.remove("spinning"), SPIN_DURATION_MS);
  }
}

let initialized = false;

function chatToast(text, kind = "success") {
  const area = document.body;
  const node = document.createElement("div");
  node.className = `chat-toast chat-toast-${kind}`;
  node.textContent = text;
  area.appendChild(node);
  setTimeout(() => node.remove(), TOAST_TTL_MS);
}

function setupMemoryPopover({ modelSelect, btnMemory, btnMemoryLabel, memoryPopover }) {
  let activeForKey = null; // ключ модели, для которой сейчас построен слайдер

  async function refreshLabel() {
    const modelKey = modelSelect.value;
    if (!modelKey) {
      btnMemoryLabel.textContent = t("ctx.btn.default");
      return;
    }
    try {
      const cur = await window.api.yarn.readCurrent(modelKey);
      if (cur && typeof cur.factor === "number" && typeof cur.original_max_position_embeddings === "number") {
        const tokens = Math.round(cur.factor * cur.original_max_position_embeddings);
        btnMemoryLabel.textContent = formatTokensShort(tokens);
      } else {
        btnMemoryLabel.textContent = t("ctx.btn.default");
      }
    } catch {
      btnMemoryLabel.textContent = t("ctx.btn.default");
    }
  }

  function rebuildSlider() {
    const modelKey = modelSelect.value;
    activeForKey = modelKey;
    memoryPopover.innerHTML = "";
    if (!modelKey) {
      const empty = document.createElement("div");
      empty.className = "memory-popover-empty";
      empty.textContent = t("ctx.btn.no_model");
      memoryPopover.appendChild(empty);
      return;
    }
    const slider = buildContextSlider({
      modelKey,
      mode: "compact",
      onApply: async (target, kvDtype) => {
        try {
          await window.api.yarn.apply(modelKey, target, kvDtype);
          chatToast(t("ctx.toast.applied"), "success");
          await refreshLabel();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          chatToast(t("ctx.toast.apply_fail", { msg }), "error");
        }
      },
      onRevert: async () => {
        try {
          await window.api.yarn.revert(modelKey);
          chatToast(t("ctx.toast.reverted"), "success");
          await refreshLabel();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          chatToast(t("ctx.toast.revert_fail", { msg }), "error");
        }
      },
    });
    memoryPopover.appendChild(slider);
  }

  function open() {
    if (memoryPopover.hidden) {
      const modelKey = modelSelect.value;
      if (activeForKey !== modelKey) rebuildSlider();
      memoryPopover.hidden = false;
      btnMemory.classList.add("active");
    }
  }
  function close() {
    if (!memoryPopover.hidden) {
      memoryPopover.hidden = true;
      btnMemory.classList.remove("active");
    }
  }
  function toggle() {
    if (memoryPopover.hidden) open();
    else close();
  }

  btnMemory.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  document.addEventListener("click", (e) => {
    if (memoryPopover.hidden) return;
    const target = e.target;
    if (target instanceof Node && (memoryPopover.contains(target) || btnMemory.contains(target))) return;
    close();
  });
  modelSelect.addEventListener("change", () => {
    refreshLabel();
    if (!memoryPopover.hidden) rebuildSlider();
  });

  refreshLabel();
}

function formatTokensShort(n) {
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1024)}K`;
  return String(n);
}

export function mountChat() {
  if (initialized) return;
  initialized = true;

  const chatArea = /** @type {HTMLDivElement} */ (getEl("chat-area"));
  const input = /** @type {HTMLTextAreaElement} */ (getEl("input"));
  const btnSend = /** @type {HTMLButtonElement} */ (getEl("btn-send"));
  const collectionSelect = /** @type {HTMLSelectElement} */ (getEl("collection-select"));
  const modelSelect = /** @type {HTMLSelectElement} */ (getEl("model-select"));
  const btnRefreshCollections = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-collections"));
  const btnRefreshModels = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-models"));
  const btnCompare = /** @type {HTMLButtonElement} */ (getEl("btn-compare"));
  const statusDot = /** @type {HTMLDivElement} */ (getEl("status-dot"));
  const btnMemory = /** @type {HTMLButtonElement} */ (getEl("btn-memory"));
  const btnMemoryLabel = /** @type {HTMLSpanElement} */ (getEl("btn-memory-label"));
  const memoryPopover = /** @type {HTMLDivElement} */ (getEl("memory-popover"));

  setupMemoryPopover({ modelSelect, btnMemory, btnMemoryLabel, memoryPopover });

  /** @param {string} role @param {string} content */
  function addMessage(role, content) {
    const cls = role === "user" ? "message message-user" : "message message-assistant";
    appendChatBubble(chatArea, cls, content, role === "assistant");
  }

  /** @param {string} text */
  function addError(text) {
    appendChatBubble(chatArea, "message message-error", text);
  }

  function showTyping() {
    removeWelcome(chatArea);
    const div = document.createElement("div");
    div.className = "typing-indicator";
    div.id = "typing";
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("div");
      dot.className = "typing-dot";
      div.appendChild(dot);
    }
    chatArea.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById("typing");
    if (el) el.remove();
  }

  /** @param {boolean} state */
  function setLoading(state) {
    isLoading = state;
    btnSend.disabled = state;
    input.disabled = state;
  }

  /** @param {boolean} qdrantOk */
  function updateStatus(qdrantOk) {
    statusDot.classList.toggle("online", qdrantOk);
    statusDot.title = qdrantOk ? t("chat.status.online") : t("chat.status.offline");
  }

  async function loadCollections() {
    await withSpin(btnRefreshCollections, async () => {
      try {
        const collections = await window.api.getCollections();
        populateSelect(collectionSelect, collections);
        updateStatus(true);
      } catch {
        populateSelect(collectionSelect, []);
        updateStatus(false);
      }
    });
  }

  async function loadModels() {
    await withSpin(btnRefreshModels, async () => {
      try {
        const models = await window.api.getModels();
        populateSelect(modelSelect, models);
      } catch {
        populateSelect(modelSelect, []);
      }
    });
  }

  /**
   * @param {string} withoutRag @param {string} withRag
   * @param {{prompt:number, completion:number, total:number}=} usageBase
   * @param {{prompt:number, completion:number, total:number}=} usageRag
   */
  function addCompareResult(withoutRag, withRag, usageBase, usageRag) {
    removeWelcome(chatArea);
    const row = document.createElement("div");
    row.className = "compare-row";

    const colBase = document.createElement("div");
    colBase.className = "compare-col";
    const labelBase = document.createElement("div");
    labelBase.className = "compare-label compare-label-base";
    labelBase.textContent = t("chat.label.without_rag");
    const textBase = document.createElement("div");
    textBase.className = "compare-text compare-text-base";
    textBase.innerHTML = renderMarkdown(withoutRag);
    colBase.append(labelBase, textBase);
    if (usageBase) {
      const stats = document.createElement("div");
      stats.className = "compare-stats compare-stats-base";
      stats.textContent = `prompt: ${usageBase.prompt} | completion: ${usageBase.completion} | total: ${usageBase.total}`;
      colBase.appendChild(stats);
    }

    const colRag = document.createElement("div");
    colRag.className = "compare-col";
    const labelRag = document.createElement("div");
    labelRag.className = "compare-label compare-label-rag";
    labelRag.textContent = t("chat.label.with_rag");
    const textRag = document.createElement("div");
    textRag.className = "compare-text compare-text-rag";
    textRag.innerHTML = renderMarkdown(withRag);
    colRag.append(labelRag, textRag);
    if (usageRag) {
      const stats = document.createElement("div");
      stats.className = "compare-stats compare-stats-rag";
      stats.textContent = `prompt: ${usageRag.prompt} | completion: ${usageRag.completion} | total: ${usageRag.total}`;
      colRag.appendChild(stats);
    }

    row.append(colBase, colRag);
    chatArea.appendChild(row);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text || isLoading) return;
    const model = modelSelect.value;
    if (!model) {
      addError(t("chat.no_model"));
      return;
    }
    input.value = "";
    input.style.height = "auto";
    addMessage("user", text);
    history.push({ role: "user", content: text });
    setLoading(true);
    showTyping();
    try {
      const collection = collectionSelect.value;
      if (compareMode && collection) {
        const result = await window.api.compareChat([...history], model, collection);
        hideTyping();
        addCompareResult(result.withoutRag, result.withRag, result.usageBase, result.usageRag);
        history.push({ role: "assistant", content: result.withRag });
      } else {
        const answer = await window.api.sendChat([...history], model, collection);
        hideTyping();
        addMessage("assistant", answer);
        history.push({ role: "assistant", content: answer });
      }
    } catch (err) {
      hideTyping();
      addError(t("chat.error", { msg: err instanceof Error ? err.message : String(err) }));
    }
    setLoading(false);
    input.focus();
  }

  btnCompare.addEventListener("click", () => {
    compareMode = !compareMode;
    btnCompare.classList.toggle("active", compareMode);
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, TEXTAREA_MAX_HEIGHT) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  btnSend.addEventListener("click", sendMessage);
  btnRefreshCollections.addEventListener("click", loadCollections);
  btnRefreshModels.addEventListener("click", loadModels);

  loadCollections();
  loadModels();
  input.focus();
}
