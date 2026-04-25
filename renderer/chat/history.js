// @ts-check
import { appendChatBubble } from "./dom-helpers.js";

let CHAT_HISTORY_CAP = 50;
let CHAT_HISTORY_PERSIST = true;

/** @type {Array<{role: string, content: string}>} */
export const history = [];
let pendingPersistTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);

export function applyChatPrefs(prefs) {
  if (typeof prefs?.chatHistoryCap === "number") CHAT_HISTORY_CAP = prefs.chatHistoryCap;
  if (typeof prefs?.chatHistoryPersist === "boolean") CHAT_HISTORY_PERSIST = prefs.chatHistoryPersist;
}

export function getHistoryCap() {
  return CHAT_HISTORY_CAP;
}

export function trimHistory() {
  if (history.length > CHAT_HISTORY_CAP) {
    history.splice(0, history.length - CHAT_HISTORY_CAP);
  }
}

export function schedulePersist() {
  if (!CHAT_HISTORY_PERSIST) return;
  if (pendingPersistTimer) clearTimeout(pendingPersistTimer);
  pendingPersistTimer = setTimeout(() => {
    pendingPersistTimer = null;
    void window.api?.chatHistory?.save(history.slice(-CHAT_HISTORY_CAP)).catch((err) => {
      console.error("[chat] history save failed:", err instanceof Error ? err.message : err);
    });
  }, 800);
}

/** @param {HTMLDivElement} chatArea */
export async function restoreHistory(chatArea) {
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
