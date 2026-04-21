// @ts-check

/**
 * Общий тонкий хелпер для построения DOM-узлов.
 * `attrs.class` → className, `attrs.style` → setAttribute("style"),
 * `attrs.html` → innerHTML, `onX` → addEventListener("x", fn).
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {Node|string|Array<Node|string|null|undefined>} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === "class") node.className = String(v);
    else if (k === "style") node.setAttribute("style", String(v));
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), /** @type {EventListener} */ (v));
    } else {
      node.setAttribute(k, String(v));
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/** @param {Element|null} node */
export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** @param {number|undefined|null} bytes */
export function fmtBytes(bytes) {
  if (!bytes) return "—";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
