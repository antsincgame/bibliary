// @ts-check

const SPIN_DURATION_MS = 600;
const TEXTAREA_MAX_HEIGHT = 120;

/** @type {Array<{role: string, content: string}>} */
const history = [];
let isLoading = false;
let compareMode = false;
let mounted = false;

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
  return md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

/** @param {HTMLDivElement} chatArea */
function removeWelcome(chatArea) {
  const welcome = chatArea.querySelector(".welcome");
  if (welcome) welcome.remove();
}

/** @param {HTMLDivElement} chatArea @param {string} className @param {string} content @param {boolean} isMarkdown */
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
    opt.textContent = "none found";
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
  await action();
  setTimeout(() => btn.classList.remove("spinning"), SPIN_DURATION_MS);
}

export function mountChat() {
  if (mounted) return;
  mounted = true;

  const chatArea = /** @type {HTMLDivElement} */ (getEl("chat-area"));
  const input = /** @type {HTMLTextAreaElement} */ (getEl("input"));
  const btnSend = /** @type {HTMLButtonElement} */ (getEl("btn-send"));
  const collectionSelect = /** @type {HTMLSelectElement} */ (getEl("collection-select"));
  const modelSelect = /** @type {HTMLSelectElement} */ (getEl("model-select"));
  const btnRefreshCollections = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-collections"));
  const btnRefreshModels = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-models"));
  const btnCompare = /** @type {HTMLButtonElement} */ (getEl("btn-compare"));
  const statusDot = /** @type {HTMLDivElement} */ (getEl("status-dot"));

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
    statusDot.title = qdrantOk ? "Qdrant online" : "Qdrant offline";
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
    labelBase.textContent = "Without RAG";
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
    labelRag.textContent = "With RAG";
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
      addError("No model selected. Load a model in LM Studio first.");
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
      addError("Error: " + (err instanceof Error ? err.message : String(err)));
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
