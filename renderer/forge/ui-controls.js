// @ts-check
import { el } from "../dom.js";
import { STATE, pageRoot, TOAST_TTL_MS } from "./state.js";

export function showToast(text, kind = "success") {
  if (!pageRoot) return;
  const area = pageRoot.querySelector("#forge-toast-area");
  if (!area) return;
  const node = el("div", { class: `chat-toast chat-toast-${kind}` }, text);
  area.appendChild(node);
  setTimeout(() => node.remove(), TOAST_TTL_MS);
}

export function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

export function labeled(label, control) {
  return el("div", { class: "forge-field" }, [
    el("label", { class: "forge-field-label" }, label),
    control,
  ]);
}

export function mkNumber(key, min, max, step) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "number",
    class: "forge-input",
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(STATE.spec[key] ?? min),
  }));
  input.addEventListener("input", () => { STATE.spec[key] = Number(input.value); });
  return input;
}

export function mkCheck(key) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    class: "forge-check",
  }));
  input.checked = !!STATE.spec[key];
  input.addEventListener("change", () => { STATE.spec[key] = input.checked; });
  return input;
}

export function mkSelect(key, options, onChange) {
  const select = /** @type {HTMLSelectElement} */ (el("select", { class: "forge-input" }));
  for (const opt of options) {
    const o = /** @type {HTMLOptionElement} */ (el("option", { value: opt }, opt));
    if (STATE.spec[key] === opt) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => {
    STATE.spec[key] = select.value;
    if (typeof onChange === "function") onChange();
  });
  return select;
}

export function mkRange(key, min, max, step, value) {
  const input = /** @type {HTMLInputElement} */ (el("input", {
    type: "range",
    class: "forge-range",
    min: String(min), max: String(max), step: String(step),
    value: String(value),
  }));
  const label = el("span", { class: "forge-range-label" }, "");
  return { input, label, wrap: el("div", { class: "forge-range-wrap" }, [input, label]) };
}
