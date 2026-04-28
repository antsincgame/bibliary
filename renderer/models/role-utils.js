// @ts-check
import { t } from "../i18n.js";

export const ROLE_ORDER = [
  "chat",
  "agent",
  "crystallizer",
  "judge",
  "vision_meta",
  "vision_ocr",
  "evaluator",
  "arena_judge",
];

export const CALIBRATABLE_ROLES = ["chat", "agent", "crystallizer", "judge", "vision_meta", "evaluator"];

const ROLE_ICONS = {
  chat: "CH",
  agent: "AG",
  crystallizer: "CR",
  judge: "JG",
  vision_meta: "VM",
  vision_ocr: "OC",
  evaluator: "EV",
  arena_judge: "AR",
};

export function roleLabel(role) {
  return t(`models.role.${role}.label`);
}

export function roleHelp(role) {
  return t(`models.role.${role}.help`);
}

export function roleIcon(role) {
  return ROLE_ICONS[role] ?? String(role).slice(0, 2).toUpperCase();
}

export function compareByRoleOrder(a, b) {
  return ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
}

export function isCalibratableRole(role) {
  return CALIBRATABLE_ROLES.includes(role);
}

export function sourceLabel(source) {
  return t(`models.source.${source || "none"}`);
}

export function sourceClass(source) {
  if (source === "preference") return "source-pref";
  if (source === "arena_top_elo") return "source-elo gold-glow";
  if (source === "auto_detect") return "source-auto";
  if (source === "fallback_list" || source === "fallback_any" || source === "profile_builtin") {
    return "source-fallback";
  }
  return "source-none";
}

export function formatElo(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "1500";
  return String(Math.round(value));
}

export function modelHasRequiredCaps(model, required) {
  for (const cap of required ?? []) {
    if (cap === "vision" && model.vision !== true) return false;
    if (cap === "tool" && model.trainedForToolUse !== true) return false;
  }
  return true;
}

export function buildMemoryEntries(loaded, downloaded) {
  const seen = new Set();
  const entries = [];
  for (const item of loaded ?? []) {
    if (!item?.modelKey || seen.has(item.modelKey)) continue;
    seen.add(item.modelKey);
    entries.push({ modelKey: item.modelKey, loaded: true });
  }
  for (const item of downloaded ?? []) {
    if (!item?.modelKey || seen.has(item.modelKey)) continue;
    seen.add(item.modelKey);
    entries.push({
      modelKey: item.modelKey,
      loaded: false,
      sizeGB: typeof item.sizeBytes === "number" ? item.sizeBytes / 1024 / 1024 / 1024 : undefined,
    });
  }
  return entries;
}
