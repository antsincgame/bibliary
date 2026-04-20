// @ts-check
import { el } from "./dom.js";

/**
 * @param {"BIG"|"SMALL"} kind
 * @param {{key:string,label:string,quant:string,sizeGB:number,minVramGB:number,capabilities:string[],ttlSec:number}} spec
 * @param {{loaded:boolean,onLoad:()=>void,onUnload:()=>void,onActivate:()=>void}} actions
 */
export function profileCard(kind, spec, actions) {
  const status = el("div", { class: `profile-status ${actions.loaded ? "online" : "offline"}` },
    actions.loaded ? "loaded" : "not loaded"
  );

  const caps = el("div", { class: "cap-badges" },
    spec.capabilities.map((c) => el("div", { class: "cap-badge" }, c))
  );

  const meta = el("dl", { class: "profile-meta" }, [
    el("dt", {}, "key"), el("dd", {}, spec.key),
    el("dt", {}, "quant"), el("dd", {}, spec.quant),
    el("dt", {}, "size"), el("dd", {}, `${spec.sizeGB.toFixed(2)} GB`),
    el("dt", {}, "min VRAM"), el("dd", {}, `${spec.minVramGB} GB`),
    el("dt", {}, "TTL"), el("dd", {}, `${spec.ttlSec}s`),
  ]);

  const buttons = el("div", { class: "btn-row" }, [
    el(
      "button",
      {
        class: kind === "BIG" ? "btn btn-gold" : "btn",
        disabled: actions.loaded ? "true" : null,
        onclick: actions.onLoad,
      },
      actions.loaded ? "Loaded" : "Load"
    ),
    el(
      "button",
      {
        class: "btn btn-ghost",
        disabled: actions.loaded ? null : "true",
        onclick: actions.onUnload,
      },
      "Unload"
    ),
    el(
      "button",
      {
        class: "btn",
        onclick: actions.onActivate,
      },
      "Set as active"
    ),
  ]);

  return el("div", { class: `profile-card profile-${kind.toLowerCase()}` }, [
    el("div", { class: "profile-name" }, spec.label),
    el("div", { class: "profile-key" }, kind === "BIG" ? "Generator + powerful inference" : "Lightweight target"),
    status,
    caps,
    meta,
    buttons,
  ]);
}
