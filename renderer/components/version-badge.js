// @ts-check
/**
 * Version badge — small fixed-position label that shows the running app
 * version, build commit and build timestamp. Mounted once at app startup.
 *
 * Goal: always-visible source of truth for "which build am I actually
 * running?". Helps the user (and the agent) diagnose situations where an
 * old binary is still launched after a code change.
 */

import { el } from "../dom.js";

const BADGE_ID = "app-version-badge";

/**
 * @typedef {{
 *   version: string;
 *   commit: string | null;
 *   builtAt: string | null;
 *   electron: string;
 *   isPackaged: boolean;
 * }} BuildInfo
 */

/**
 * Format ISO timestamp into compact local "YYYY-MM-DD HH:mm" form.
 * @param {string | null} iso
 * @returns {string}
 */
function formatBuiltAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Mount the version badge in the bottom-right corner of the window.
 * Idempotent: re-calling will refresh the existing badge instead of
 * creating duplicates.
 */
export async function mountVersionBadge() {
  /** @type {BuildInfo | null} */
  let info = null;
  try {
    info = await /** @type {any} */ (window).api.system.appVersion();
  } catch (err) {
    console.warn("[version-badge] failed to fetch app version:", err);
  }

  const version = info?.version ?? "?.?.?";
  const commit = info?.commit ?? "";
  const builtAt = formatBuiltAt(info?.builtAt ?? null);
  const mode = info?.isPackaged ? "packaged" : "dev";
  const electron = info?.electron ?? "";

  const tooltipLines = [
    `Bibliary v${version}`,
    commit ? `commit: ${commit}` : null,
    builtAt ? `built: ${builtAt}` : null,
    `mode: ${mode}`,
    electron ? `electron: ${electron}` : null,
  ].filter(Boolean);

  const labelText = commit
    ? `v${version} · ${commit}`
    : `v${version}`;

  const badge = /** @type {HTMLElement} */ (el("div", {
    id: BADGE_ID,
    class: "app-version-badge",
    title: tooltipLines.join("\n"),
    role: "status",
    "aria-label": `Bibliary version ${version}`,
  }, labelText));

  const existing = document.getElementById(BADGE_ID);
  if (existing) existing.remove();
  document.body.appendChild(badge);
}
