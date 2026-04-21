// @ts-check
import { t } from "./i18n.js";

const KEYS = ["chunk", "T1", "T2", "T3", "fewshot", "batch", "mechanicus"];

let activePopover = null;

function closePopover() {
  if (!activePopover) return;
  activePopover.remove();
  activePopover = null;
  document.removeEventListener("click", onDocClick, true);
  document.removeEventListener("keydown", onEsc, true);
}

function onDocClick(e) {
  if (!activePopover) return;
  if (!activePopover.contains(e.target) && !e.target.closest?.(".glossary-trigger")) {
    closePopover();
  }
}

function onEsc(e) {
  if (e.key === "Escape") closePopover();
}

function buildPopover(entries) {
  const root = document.createElement("div");
  root.className = "glossary-pop";
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "glossary-item";

    const title = document.createElement("div");
    title.className = "glossary-title";
    title.textContent = entry.title;

    const body = document.createElement("div");
    body.className = "glossary-body";
    body.textContent = entry.body;

    item.appendChild(title);
    item.appendChild(body);
    root.appendChild(item);
  }
  return root;
}

function positionPopover(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 320)}px`;
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 360))}px`;
  pop.style.maxWidth = "340px";
  pop.style.zIndex = "10000";
}

function entriesFor(keys) {
  const list = (keys && keys.length ? keys : KEYS)
    .map((k) => ({ title: t(`glossary.${k}.title`), body: t(`glossary.${k}.body`) }))
    .filter((e) => e.title && e.body);
  return list;
}

export function showGlossary(anchor, keys) {
  closePopover();
  const list = entriesFor(keys);
  if (list.length === 0) return;

  const pop = buildPopover(list);
  document.body.appendChild(pop);
  positionPopover(pop, anchor);
  activePopover = pop;

  setTimeout(() => {
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onEsc, true);
  }, 0);
}

export function makeGlossaryButton(keyOrKeys, label = "?") {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "glossary-trigger";
  btn.textContent = label;
  btn.title = t("stepper.help.title");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showGlossary(btn, keys);
  });
  return btn;
}
