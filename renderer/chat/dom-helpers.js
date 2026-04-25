// @ts-check
import { t } from "../i18n.js";
import { renderMarkdown } from "./markdown.js";

/** @param {string} id @returns {HTMLElement} */
export function getEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

/** @param {HTMLDivElement} chatArea */
export function removeWelcome(chatArea) {
  const welcome = chatArea.querySelector(".welcome");
  if (welcome) welcome.remove();
}

/**
 * @param {HTMLDivElement} chatArea
 * @param {string} className
 * @param {string} content
 * @param {boolean} [isMarkdown]
 */
export function appendChatBubble(chatArea, className, content, isMarkdown = false) {
  removeWelcome(chatArea);
  const div = document.createElement("div");
  div.className = className;
  if (isMarkdown) div.innerHTML = renderMarkdown(content);
  else div.textContent = content;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

/** @param {HTMLSelectElement} select @param {Array<string|{id:string}>} items */
export function populateSelect(select, items) {
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

/** @param {HTMLButtonElement} btn @param {() => Promise<void>} action @param {number} spinMs */
export async function withSpin(btn, action, spinMs = 600) {
  btn.classList.add("spinning");
  try {
    await action();
  } finally {
    setTimeout(() => btn.classList.remove("spinning"), spinMs);
  }
}

/** @param {string} text @param {string} kind @param {number} ttl */
export function chatToast(text, kind = "success", ttl = 5000) {
  const area = document.body;
  const node = document.createElement("div");
  node.className = `chat-toast chat-toast-${kind}`;
  node.textContent = text;
  area.appendChild(node);
  setTimeout(() => node.remove(), ttl);
}

/** @param {number} n */
export function formatTokensShort(n) {
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1_000) return `${Math.round((n / 1_000) * 10) / 10}K`;
  return String(n);
}
