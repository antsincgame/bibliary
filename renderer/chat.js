// @ts-check
/**
 * Chat tab — thin mount orchestrator.
 *
 * Implementation split:
 *   chat/markdown.js       — marked + DOMPurify rendering
 *   chat/dom-helpers.js    — getEl, bubbles, toasts, populateSelect
 *   chat/history.js        — in-memory history + disk persistence
 *   chat/memory-popover.js — YaRN context slider popover
 *   chat/qdrant-ui.js      — collection create dialog, dashboard link
 */
import { t } from "./i18n.js";
import { buildModelSelect } from "./components/model-select.js";
import { buildNeonHero } from "./components/neon-helpers.js";
import { renderMarkdown } from "./chat/markdown.js";
import { getEl, removeWelcome, appendChatBubble, populateSelect, withSpin, chatToast } from "./chat/dom-helpers.js";
import { history, applyChatPrefs, getHistoryCap, trimHistory, schedulePersist, restoreHistory } from "./chat/history.js";
import { setupMemoryPopover } from "./chat/memory-popover.js";
import { promptCollectionName, maybeOpenQdrantDashboard } from "./chat/qdrant-ui.js";

let SPIN_DURATION_MS = 600;
let TOAST_TTL_MS = 5000;

(async () => {
  try {
    const prefs = await window.api?.preferences?.getAll();
    if (!prefs) return;
    if (typeof prefs.spinDurationMs === "number") SPIN_DURATION_MS = prefs.spinDurationMs;
    if (typeof prefs.toastTtlMs === "number") TOAST_TTL_MS = prefs.toastTtlMs;
    applyChatPrefs(prefs);
  } catch { /* defaults */ }
})();

let initialized = false;
let isLoading = false;
let compareMode = false;

export function mountChat() {
  if (initialized) return;
  initialized = true;

  const chatArea = /** @type {HTMLDivElement} */ (getEl("chat-area"));
  const welcomeRoot = document.getElementById("chat-welcome-root");
  if (welcomeRoot && welcomeRoot.children.length === 0) {
    welcomeRoot.appendChild(
      buildNeonHero({
        title: t("chat.welcome.title"),
        subtitle: t("chat.welcome.sub"),
        pattern: "flower",
      })
    );
  }
  const input = /** @type {HTMLTextAreaElement} */ (getEl("input"));
  const TEXTAREA_MAX_HEIGHT = 120;
  const btnSend = /** @type {HTMLButtonElement} */ (getEl("btn-send"));
  const collectionSelect = /** @type {HTMLSelectElement} */ (getEl("collection-select"));
  const btnRefreshCollections = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-collections"));
  const btnRefreshModels = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-models"));
  const btnCompare = /** @type {HTMLButtonElement} */ (getEl("btn-compare"));
  const statusDot = /** @type {HTMLDivElement} */ (getEl("status-dot"));
  const btnMemory = /** @type {HTMLButtonElement} */ (getEl("btn-memory"));
  const btnMemoryLabel = /** @type {HTMLSpanElement} */ (getEl("btn-memory-label"));
  const memoryPopover = /** @type {HTMLDivElement} */ (getEl("memory-popover"));

  const oldModelSelect = /** @type {HTMLSelectElement} */ (getEl("model-select"));
  const chatModelInstance = buildModelSelect({
    role: "chat",
    selectId: "model-select",
    bare: true,
    loadOnSelect: true,
    onLoaded: (modelKey) => {
      chatToast(t("chat.toast.model_loaded", { model: modelKey }), "success", TOAST_TTL_MS);
      maybeShowAssistantWelcome();
    },
    onLoadError: (err) => {
      chatToast(t("chat.toast.model_load_fail", { msg: err.message }), "error", TOAST_TTL_MS);
    },
  });
  oldModelSelect.replaceWith(chatModelInstance.select);
  const modelSelect = chatModelInstance.select;

  const btnCreateCollection = /** @type {HTMLButtonElement|null} */ (
    document.getElementById("btn-create-collection")
  );

  setupMemoryPopover({ modelSelect, btnMemory, btnMemoryLabel, memoryPopover });

  // ── Local helpers that capture DOM closure ──────────────────────────────

  function maybeShowAssistantWelcome() {
    if (history.length > 0) return;
    if (!modelSelect.value) return;
    if (chatArea.querySelector(".welcome-assistant")) return;
    removeWelcome(chatArea);
    const collection = collectionSelect.value || t("chat.welcome.no_collection");
    const model = modelSelect.value;
    const md = t("chat.welcome.assistant_md", { model, collection });
    const div = document.createElement("div");
    div.className = "message message-assistant welcome-assistant";
    div.innerHTML = renderMarkdown(md);
    chatArea.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  async function handleCreateCollection() {
    const trimmed = await promptCollectionName();
    if (!trimmed) return;
    try {
      const result = /** @type {any} */ (await window.api.qdrant.create({ name: trimmed }));
      if (!result || result.ok === false) {
        const errText = (result && result.error) || "unknown";
        chatToast(t("chat.toast.create_collection_fail", { msg: errText }), "error", TOAST_TTL_MS);
        await maybeOpenQdrantDashboard(errText);
        return;
      }
      chatToast(t("chat.toast.create_collection_ok", { name: trimmed }), "success", TOAST_TTL_MS);
      await loadCollections();
      collectionSelect.value = trimmed;
      maybeShowAssistantWelcome();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      chatToast(t("chat.toast.create_collection_fail", { msg }), "error", TOAST_TTL_MS);
      await maybeOpenQdrantDashboard(msg);
    }
  }

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
      updateCompareAvailability();
    }, SPIN_DURATION_MS);
  }

  async function refreshModels() {
    await withSpin(btnRefreshModels, async () => {
      await chatModelInstance.refresh();
    }, SPIN_DURATION_MS);
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
    setLoading(true);
    input.value = "";
    input.style.height = "auto";
    addMessage("user", text);
    history.push({ role: "user", content: text });
    trimHistory();
    showTyping();
    try {
      const collection = collectionSelect.value;
      const sendable = history.slice(-getHistoryCap());
      if (compareMode && collection) {
        const result = await window.api.compareChat(sendable, model, collection);
        hideTyping();
        addCompareResult(result.withoutRag, result.withRag, result.usageBase, result.usageRag);
        history.push({ role: "assistant", content: result.withRag });
      } else {
        const answer = await window.api.sendChat(sendable, model, collection);
        hideTyping();
        addMessage("assistant", answer);
        history.push({ role: "assistant", content: answer });
      }
      trimHistory();
      schedulePersist();
    } catch (err) {
      hideTyping();
      addError(t("chat.error", { msg: err instanceof Error ? err.message : String(err) }));
    }
    setLoading(false);
    input.focus();
  }

  // ── Compare availability ───────────────────────────────────────────────

  function updateCompareAvailability() {
    const hasCollection = collectionSelect.value.trim().length > 0;
    btnCompare.disabled = !hasCollection;
    btnCompare.title = hasCollection ? "" : t("chat.compare.tooltip_no_collection");
    if (!hasCollection && compareMode) {
      compareMode = false;
      btnCompare.classList.remove("active");
    }
  }

  // ── Event listeners ────────────────────────────────────────────────────

  btnCompare.addEventListener("click", () => {
    if (!collectionSelect.value.trim()) {
      chatToast(t("chat.compare.no_collection"), "info", TOAST_TTL_MS);
      return;
    }
    compareMode = !compareMode;
    btnCompare.classList.toggle("active", compareMode);
  });
  collectionSelect.addEventListener("change", updateCompareAvailability);
  updateCompareAvailability();
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
  btnRefreshModels.addEventListener("click", refreshModels);
  if (btnCreateCollection) {
    btnCreateCollection.addEventListener("click", () => void handleCreateCollection());
  }
  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) maybeShowAssistantWelcome();
  });

  loadCollections();
  void restoreHistory(chatArea).then(() => maybeShowAssistantWelcome());
  input.focus();
}
