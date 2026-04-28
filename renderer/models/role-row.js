// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";
import {
  formatElo,
  isCalibratableRole,
  modelHasRequiredCaps,
  roleHelp,
  roleIcon,
  roleLabel,
  sourceClass,
  sourceLabel,
} from "./role-utils.js";

function capabilityBadges(entry) {
  const caps = [];
  for (const cap of entry.required ?? []) caps.push(el("span", { class: "role-cap role-cap-required" }, cap.toUpperCase()));
  for (const cap of entry.preferred ?? []) {
    if ((entry.required ?? []).includes(cap)) continue;
    caps.push(el("span", { class: "role-cap" }, cap.toUpperCase()));
  }
  return caps.length > 0 ? caps : [el("span", { class: "role-cap role-cap-muted" }, t("models.role.no_caps"))];
}

function modelLabel(model) {
  const caps = [];
  if (model.vision) caps.push("VISION");
  if (model.trainedForToolUse) caps.push("TOOLS");
  return caps.length > 0 ? `${model.modelKey} [${caps.join(", ")}]` : model.modelKey;
}

export function buildRoleRow({ entry, loaded, ratings, onChangeModel, onCalibrate }) {
  const resolvedKey = entry.resolved?.modelKey ?? "";
  const roleRatings = ratings?.[entry.role] ?? {};
  const source = entry.resolved?.source ?? "";
  const row = el("div", { class: `role-row ${sourceClass(source)}` });

  const select = el("select", {
    class: "role-select",
    "aria-label": t("models.role.select_model", { role: roleLabel(entry.role) }),
  });
  select.appendChild(el("option", { value: "" }, t("models.role.auto")));
  let hasResolvedOption = resolvedKey === "";
  for (const model of loaded) {
    const compatible = modelHasRequiredCaps(model, entry.required);
    const option = el("option", { value: model.modelKey }, compatible
      ? modelLabel(model)
      : `${modelLabel(model)} (${t("models.role.incompatible")})`);
    if (!compatible) option.disabled = true;
    if (model.modelKey === resolvedKey) option.selected = true;
    if (model.modelKey === resolvedKey) hasResolvedOption = true;
    select.appendChild(option);
  }
  if (!hasResolvedOption) {
    const option = el("option", { value: resolvedKey, disabled: "disabled" }, `${resolvedKey} (${t("models.role.not_loaded")})`);
    option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    if (onChangeModel) onChangeModel(entry, select.value);
  });

  const calibrate = el("button", {
    class: "cyber-button cyber-button-ghost role-calibrate",
    type: "button",
    disabled: isCalibratableRole(entry.role) ? undefined : "disabled",
    title: isCalibratableRole(entry.role) ? t("models.calibrate_one") : t("models.calibrate_unavailable"),
  }, t("models.calibrate"));
  calibrate.addEventListener("click", () => {
    if (!calibrate.disabled && onCalibrate) onCalibrate(entry);
  });

  row.append(
    el("div", { class: "role-mark", "aria-hidden": "true" }, roleIcon(entry.role)),
    el("div", { class: "role-copy" }, [
      el("div", { class: "role-title-line" }, [
        el("strong", { class: "role-title" }, roleLabel(entry.role)),
        el("span", { class: `source-badge ${sourceClass(source)}` }, sourceLabel(source)),
      ]),
      el("div", { class: "role-help" }, roleHelp(entry.role)),
      el("div", { class: "role-caps" }, capabilityBadges(entry)),
    ]),
    el("div", { class: "role-current" }, [
      el("span", { class: "role-current-label" }, t("models.role.current")),
      el("span", { class: "role-current-model" }, resolvedKey || t("models.role.none")),
      el("span", { class: "elo-badge" }, `ELO ${resolvedKey ? formatElo(roleRatings[resolvedKey]) : "—"}`),
    ]),
    el("div", { class: "role-controls" }, [select, calibrate]),
  );
  return row;
}
