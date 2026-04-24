// @ts-check
import { el } from "../dom.js";

/** @type {Map<string, number>} */
const recentToastKeys = new Map();

/**
 * Bottom-right non-blocking toast for Library route.
 * @param {{
 *   message: string;
 *   kind?: "success" | "error" | "info";
 *   actionLabel?: string;
 *   onAction?: () => void | Promise<void>;
 *   ttlMs?: number;
 *   dedupeKey?: string;
 *   dedupeMs?: number;
 * }} opts
 */
export function showLibraryToast(opts) {
  if (opts.dedupeKey) {
    const now = Date.now();
    const windowMs = typeof opts.dedupeMs === "number" ? opts.dedupeMs : 3000;
    const last = recentToastKeys.get(opts.dedupeKey) ?? 0;
    if (now - last < windowMs) return;
    recentToastKeys.set(opts.dedupeKey, now);
  }
  const kind = opts.kind || "info";
  const node = el(
    "div",
    { class: `chat-toast ${kind === "error" ? "chat-toast-error" : "chat-toast-success"} lib-toast` },
    []
  );
  node.appendChild(el("div", { class: "lib-toast-message" }, opts.message));
  if (opts.actionLabel && opts.onAction) {
    const action = /** @type {HTMLButtonElement} */ (
      el("button", { type: "button", class: "lib-toast-action" }, opts.actionLabel)
    );
    action.addEventListener("click", () => {
      try {
        void opts.onAction?.();
      } finally {
        node.remove();
      }
    });
    node.appendChild(action);
  }
  document.body.appendChild(node);
  const ttl = typeof opts.ttlMs === "number" ? opts.ttlMs : 6000;
  setTimeout(() => node.remove(), ttl);
}
