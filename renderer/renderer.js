// @ts-check

/** @type {Array<{role: string, content: string}>} */
const history = [];

const SPIN_DURATION_MS = 600;
const TEXTAREA_MAX_HEIGHT = 120;

/** @param {string} id @returns {HTMLElement} */
function getEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

const chatArea = /** @type {HTMLDivElement} */ (getEl("chat-area"));
const input = /** @type {HTMLTextAreaElement} */ (getEl("input"));
const btnSend = /** @type {HTMLButtonElement} */ (getEl("btn-send"));
const collectionSelect = /** @type {HTMLSelectElement} */ (getEl("collection-select"));
const modelSelect = /** @type {HTMLSelectElement} */ (getEl("model-select"));
const btnRefreshCollections = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-collections"));
const btnRefreshModels = /** @type {HTMLButtonElement} */ (getEl("btn-refresh-models"));
const statusDot = /** @type {HTMLDivElement} */ (getEl("status-dot"));

const PING_INTERVAL_MS = 15000;

let isLoading = false;

function removeWelcome() {
  const welcome = chatArea.querySelector(".welcome");
  if (welcome) welcome.remove();
}

/** @param {string} className @param {string} content */
function appendChatBubble(className, content) {
  removeWelcome();
  const div = document.createElement("div");
  div.className = className;
  div.textContent = content;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

/** @param {string} role @param {string} content */
function addMessage(role, content) {
  const cls = role === "user" ? "message message-user" : "message message-assistant";
  appendChatBubble(cls, content);
}

/** @param {string} text */
function addError(text) {
  appendChatBubble("message message-error", text);
}

function showTyping() {
  removeWelcome();
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

async function loadCollections() {
  await withSpin(btnRefreshCollections, async () => {
    const collections = await window.api.getCollections().catch(() => []);
    populateSelect(collectionSelect, collections);
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

/** @param {boolean} qdrantOk @param {boolean} lmOk */
function updateStatus(qdrantOk, lmOk = false) {
  const allOk = qdrantOk && lmOk;
  statusDot.classList.toggle("online", allOk);
  const qdrantLabel = qdrantOk ? "online" : "offline";
  const lmLabel = lmOk ? "online" : "offline";
  statusDot.title = `Qdrant: ${qdrantLabel} | LM Studio: ${lmLabel}`;
}

async function pingServices() {
  const [qdrantOk, lmOk] = await Promise.all([
    window.api.pingQdrant().catch(() => false),
    window.api.pingLmStudio().catch(() => false),
  ]);
  updateStatus(qdrantOk, lmOk);
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
    const answer = await window.api.sendChat([...history], model, collection);
    hideTyping();
    addMessage("assistant", answer);
    history.push({ role: "assistant", content: answer });
  } catch (err) {
    hideTyping();
    addError("Error: " + (err instanceof Error ? err.message : String(err)));
  }

  setLoading(false);
  input.focus();
}

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

pingServices();
setInterval(pingServices, PING_INTERVAL_MS);
loadCollections();
loadModels();
input.focus();
