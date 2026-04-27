// @ts-check
/**
 * Centralized toast notification manager.
 *
 * Cross-route, non-blocking toast notifications with queuing (max 3 visible).
 * Reuses existing CSS classes (`chat-toast`, `lib-toast`) for visual consistency.
 *
 * API:
 *   toast.success(msg [, opts])
 *   toast.error(msg [, opts])
 *   toast.warn(msg [, opts])
 *   toast.info(msg [, opts])
 *   toast.show(opts)     ← raw opts if needed
 *
 * @module toast-manager
 */

import { el } from "../dom.js";

const MAX_VISIBLE = 3;
const DEFAULT_TTL_MS = 6000;
const DEDUPE_WINDOW_MS = 3000;

/** @type {Map<string, number>} */
const recentKeys = new Map();

/** @type {HTMLElement | null} */
let _container = null;

function getContainer() {
  if (!_container || !document.body.contains(_container)) {
    _container = el("div", { class: "toast-manager-stack" });
    document.body.appendChild(_container);
  }
  return _container;
}

/**
 * @param {{
 *   message: string;
 *   kind?: "success" | "error" | "warn" | "info";
 *   ttlMs?: number;
 *   actionLabel?: string;
 *   onAction?: () => void | Promise<void>;
 *   dedupeKey?: string;
 *   dedupeMs?: number;
 * }} opts
 */
function show(opts) {
  if (opts.dedupeKey) {
    const now = Date.now();
    const windowMs = opts.dedupeMs ?? DEDUPE_WINDOW_MS;
    const last = recentKeys.get(opts.dedupeKey) ?? 0;
    if (now - last < windowMs) return;
    recentKeys.set(opts.dedupeKey, now);
  }

  const c = getContainer();

  // Evict oldest if at capacity.
  const existing = c.querySelectorAll(".toast-manager-item");
  if (existing.length >= MAX_VISIBLE) existing[0].remove();

  const kind = opts.kind ?? "info";
  const kindClass = kind === "error" ? "chat-toast-error" : "chat-toast-success";

  const node = el("div", {
    class: `chat-toast ${kindClass} lib-toast toast-manager-item toast-kind-${kind}`,
    role: "alert",
    "aria-live": "polite",
  });

  node.appendChild(el("div", { class: "lib-toast-message" }, opts.message));

  if (opts.actionLabel && opts.onAction) {
    const btn = /** @type {HTMLButtonElement} */ (
      el("button", { type: "button", class: "lib-toast-action" }, opts.actionLabel)
    );
    btn.addEventListener("click", () => {
      try { void opts.onAction?.(); } finally { dismiss(); }
    });
    node.appendChild(btn);
  }

  c.appendChild(node);

  const ttl = typeof opts.ttlMs === "number" ? opts.ttlMs : DEFAULT_TTL_MS;

  function dismiss() {
    if (!node.isConnected) return;
    node.classList.add("toast-exiting");
    setTimeout(() => node.remove(), 300);
  }

  const timer = setTimeout(dismiss, ttl);
  node.addEventListener("click", () => { clearTimeout(timer); dismiss(); }, { once: true });
}

/**
 * @param {string} msg
 * @param {Omit<Parameters<typeof show>[0], "message" | "kind">} [opts]
 */
function success(msg, opts) { show({ ...opts, message: msg, kind: "success" }); }

/**
 * @param {string} msg
 * @param {Omit<Parameters<typeof show>[0], "message" | "kind">} [opts]
 */
function error(msg, opts) { show({ ...opts, message: msg, kind: "error" }); }

/**
 * @param {string} msg
 * @param {Omit<Parameters<typeof show>[0], "message" | "kind">} [opts]
 */
function warn(msg, opts) { show({ ...opts, message: msg, kind: "warn" }); }

/**
 * @param {string} msg
 * @param {Omit<Parameters<typeof show>[0], "message" | "kind">} [opts]
 */
function info(msg, opts) { show({ ...opts, message: msg, kind: "info" }); }

export const toast = { success, error, warn, info, show };
