// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";

/**
 * @param {"BIG"|"SMALL"} kind
 * @param {{key:string,label:string,quant:string,sizeGB:number,minVramGB:number,capabilities:string[],ttlSec:number}} spec
 * @param {{loaded:boolean,onLoad:()=>void,onUnload:()=>void,onActivate:()=>void}} actions
 */
export function profileCard(kind, spec, actions) {
  const status = el(
    "div",
    { class: `profile-status ${actions.loaded ? "online" : "offline"}` },
    actions.loaded ? t("models.profile.loaded") : t("models.profile.not_loaded")
  );

  const caps = el(
    "div",
    { class: "cap-badges" },
    spec.capabilities.map((c) => el("div", { class: "cap-badge" }, c))
  );

  const meta = el("dl", { class: "profile-meta" }, [
    el("dt", {}, t("models.profile.key")), el("dd", {}, spec.key),
    el("dt", {}, t("models.profile.quant")), el("dd", {}, spec.quant),
    el("dt", {}, t("models.profile.size")), el("dd", {}, `${spec.sizeGB.toFixed(2)} GB`),
    el("dt", {}, t("models.profile.min_vram")), el("dd", {}, `${spec.minVramGB} GB`),
    el("dt", {}, t("models.profile.ttl")), el("dd", {}, `${spec.ttlSec}s`),
  ]);

  const buttons = el("div", { class: "btn-row" }, [
    el(
      "button",
      {
        class: kind === "BIG" ? "btn btn-gold" : "btn",
        disabled: actions.loaded ? "true" : null,
        onclick: actions.onLoad,
      },
      actions.loaded ? t("models.btn.loaded") : t("models.btn.load")
    ),
    el(
      "button",
      {
        class: "btn btn-ghost",
        disabled: actions.loaded ? null : "true",
        onclick: actions.onUnload,
      },
      t("models.btn.unload")
    ),
    el("button", { class: "btn", onclick: actions.onActivate }, t("models.btn.activate")),
  ]);

  return el("div", { class: `profile-card profile-${kind.toLowerCase()}` }, [
    el("div", { class: "profile-name" }, spec.label),
    el(
      "div",
      { class: "profile-key" },
      kind === "BIG" ? t("models.profile.big.role") : t("models.profile.small.role")
    ),
    status,
    caps,
    meta,
    buttons,
  ]);
}
