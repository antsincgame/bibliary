// @ts-check
import { t } from "./i18n.js";
import { buildContextSlider } from "./components/context-slider.js";
import { buildModelSelect } from "./components/model-select.js";

let SPIN_DURATION_MS = 600;
const TEXTAREA_MAX_HEIGHT = 120;
let TOAST_TTL_MS = 5000;
let CHAT_HISTORY_CAP = 50;
let CHAT_HISTORY_PERSIST = true;

(async () => {
  try {
    const prefs = await window.api?.preferences?.getAll();
    if (!prefs) return;
    if (typeof prefs.spinDurationMs === "number") SPIN_DURATION_MS = prefs.spinDurationMs;
    if (typeof prefs.toastTtlMs === "number") TOAST_TTL_MS = prefs.toastTtlMs;
    if (typeof prefs.chatHistoryCap === "number") CHAT_HISTORY_CAP = prefs.chatHistoryCap;
    if (typeof prefs.chatHistoryPersist === "boolean") CHAT_HISTORY_PERSIST = prefs.chatHistoryPersist;
  } catch { /* defaults */ }
})();

/** @type {Array<{role: string, content: string}>} */
const history = [];
let isLoading = false;
let compareMode = false;
let pendingPersistTimer = null;

/**
 * Cap history at CHAT_HISTORY_CAP messages. FIFO eviction -- oldest
 * user/assistant pairs drop first. Keeps IPC payload bounded.
 */
function trimHistory() {
  if (history.length > CHAT_HISTORY_CAP) {
    history.splice(0, history.length - CHAT_HISTORY_CAP);
  }
}

/**
 * Schedule a debounced save to disk. Multiple sends in quick succession
 * collapse into a single write.
 */
function schedulePersist() {
  if (!CHAT_HISTORY_PERSIST) return;
  if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
  pendingPersistTimer = setTimeout(() => {
    pendingPersistTimer = null;
    void window.api?.chatHistory?.save(history.slice(-CHAT_HISTORY_CAP)).catch((err) => {
      console.error("[chat] history save failed:", err instanceof Error ? err.message : err);
    });
  }, 800);
}

/**
 * Restore history from disk on first chat mount. Re-renders bubbles
 * for every restored message so the user sees a populated thread.
 */
async function restoreHistory(chatArea) {
  if (!CHAT_HISTORY_PERSIST) return;
  try {
    const saved = await window.api?.chatHistory?.load();
    if (!Array.isArray(saved) || saved.length === 0) return;
    for (const m of saved) {
      history.push({ role: m.role, content: m.content });
      const cls = m.role === "user" ? "message message-user" : "message message-assistant";
      appendChatBubble(chatArea, cls, m.content, m.role === "assistant");
    }
    trimHistory();
  } catch (err) {
    console.error("[chat] history restore failed:", err instanceof Error ? err.message : err);
  }
}

/** @param {string} id @returns {HTMLElement} */
function getEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

/* Whitelist для DOMPurify: то, что нужно для markdown-чата от LLM.
   Намеренно НЕТ: <script>, <iframe>, <object>, <embed>, <form>, <input>,
   <style>, <svg> (могут содержать <script> внутри), а также on*-атрибуты
   и href="javascript:...". Защищает от prompt-injection XSS даже при
   текущей CSP, которая не блокирует data-exfil через <img src="..."/>. */
const SAFE_MD_TAGS = [
  "p", "br", "hr", "strong", "em", "b", "i", "u", "s", "del", "ins",
  "code", "pre", "blockquote", "kbd", "mark", "small", "sub", "sup",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "a", "img", "span", "div",
];
const SAFE_MD_ATTRS = ["href", "title", "alt", "src", "class", "lang", "id", "target", "rel"];

/** @param {string} md */
function renderMarkdown(md) {
  let html;
  if (typeof window.marked !== "undefined" && window.marked.parse) {
    html = window.marked.parse(md, { breaks: true });
  } else {
    return md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }
  if (typeof window.DOMPurify !== "undefined" && window.DOMPurify.sanitize) {
    return window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: SAFE_MD_TAGS,
      ALLOWED_ATTR: SAFE_MD_ATTRS,
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input"],
      FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
    });
  }
  /* Fail-closed: без санитайзера НЕ возвращаем сырой HTML — экранируем. */
  console.warn("[chat] DOMPurify not loaded — falling back to escaped text");
  return md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const btnRefreshCollections = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-collections"));
  const btnRefreshModels = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-models"));
  const btnCompare = /** @type {HTMLButtonElement} */ (getEl("btn-compare"));
  const statusDot = /** @type {HTMLDivElement} */ (getEl("status-dot"));
  const btnMemory = /** @type {HTMLButtonElement} */ (getEl("btn-memory"));
  const btnMemoryLabel = /** @type {HTMLSpanElement} */ (getEl("btn-memory-label"));
  const memoryPopover = /** @type {HTMLDivElement} */ (getEl("memory-popover"));

  /* Phase 3 Удар 2 / B.4-полная: заменяем inline <select id="model-select"> на
     общий buildModelSelect (bare-режим — у chat header свой layout с label).
     Источник моделей унифицирован: lmstudio.listLoaded() (был getModels()).
     Persist в preferences.chatModel автоматический; pickBestModel fallback по
     общим DEFAULT_MODEL_HINTS. ID "model-select" сохранён → DOM-querySelector
     и стили продолжают работать без изменений. */
  const oldModelSelect = /** @type {HTMLSelectElement} */ (getEl("model-select"));
  const chatModelInstance = buildModelSelect({
    role: "chat",
    selectId: "model-select",
    bare: true,
    loadOnSelect: true,
    onLoaded: (modelKey) => {
      chatToast(t("chat.toast.model_loaded", { model: modelKey }), "success");
      maybeShowAssistantWelcome();
    },
    onLoadError: (err) => {
      chatToast(t("chat.toast.model_load_fail", { msg: err.message }), "error");
    },
  });
  oldModelSelect.replaceWith(chatModelInstance.select);
  const modelSelect = chatModelInstance.select;

  const btnCreateCollection = /** @type {HTMLButtonElement|null} */ (
    document.getElementById("btn-create-collection")
  );

  setupMemoryPopover({ modelSelect, btnMemory, btnMemoryLabel, memoryPopover });

  /**
   * Если в LM Studio есть модель и у пользователя нет истории — показать
   * приветственное сообщение от ассистента с инструкцией с чего начать.
   * Вызывается дважды: при первом mount (если уже есть loaded model) и
   * после успешной auto-load выбранной downloaded model.
   */
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
    const name = window.prompt(t("chat.toast.create_collection_prompt"), "");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const result = /** @type {any} */ (await window.api.qdrant.create({ name: trimmed }));
      if (!result || result.ok === false) {
        const errMsg = (result && result.error) || "unknown";
        chatToast(t("chat.toast.create_collection_fail", { msg: errMsg }), "error");
        return;
      }
      chatToast(t("chat.toast.create_collection_ok", { name: trimmed }), "success");
      await loadCollections();
      collectionSelect.value = trimmed;
      maybeShowAssistantWelcome();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      chatToast(t("chat.toast.create_collection_fail", { msg }), "error");
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
      /* A6: после re-populate коллекция могла стать пустой (backend оффлайн)
         или появиться/исчезнуть выбранная — пересчитаем availability */
      updateCompareAvailability();
    });
  }

  async function refreshModels() {
    await withSpin(btnRefreshModels, async () => {
      await chatModelInstance.refresh();
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
    /* AUDIT P1 (god): атомарная блокировка ДО мутации DOM/history.
       Раньше setLoading(true) шёл после addMessage+history.push,
       и двойной клик/Enter+click в одном тике мог продавить guard,
       создавая два параллельных запроса с расхождением истории. */
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
      /* Send only the capped tail. Previously we spread the entire
         history -- IPC payload grew linearly with conversation length
         and eventually hit IPC size limits in long sessions. */
      const sendable = history.slice(-CHAT_HISTORY_CAP);
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

  /* A6: Compare без коллекции бессмысленна — backend в `compareChat`
     отдаёт два почти идентичных ответа на пустой коллекции. Раньше юзер
     включал режим, получал две одинаковые колонки и думал что баг.
     Теперь:
       - кнопка disabled пока коллекция пуста
       - tooltip объясняет почему
       - клик при пустой коллекции (на disabled-кнопку браузер не пошлёт,
         но keyboard accessibility) показывает toast */
  function updateCompareAvailability() {
    const hasCollection = collectionSelect.value.trim().length > 0;
    btnCompare.disabled = !hasCollection;
    btnCompare.title = hasCollection ? "" : t("chat.compare.tooltip_no_collection");
    if (!hasCollection && compareMode) {
      compareMode = false;
      btnCompare.classList.remove("active");
    }
  }
  btnCompare.addEventListener("click", () => {
    if (!collectionSelect.value.trim()) {
      chatToast(t("chat.compare.no_collection"), "info");
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
  /* Модели грузятся автоматически внутри buildModelSelect (см. mountChat выше). */
  /* Restore previous session before user starts typing -- non-blocking. */
  void restoreHistory(chatArea).then(() => maybeShowAssistantWelcome());
  input.focus();
}
