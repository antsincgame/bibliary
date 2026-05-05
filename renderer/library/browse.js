// @ts-check
/**
 * Library prefs loader.
 *
 * MVP v1.0.1: stripped to just `loadPrefs` -- the legacy browse/queue/preview
 * UI was removed (see CHANGELOG 1.0.0). Other helpers were dead code.
 */

import { STATE } from "./state.js";

export async function loadPrefs() {
  try {
    const prefs = await window.api.preferences.getAll();
    STATE.prefs.queueParallelism = Number(prefs.ingestParallelism) || 3;
    STATE.prefs.ocrEnabled = Boolean(prefs.ocrEnabled);
    STATE.prefs.groupBy = String(prefs.libraryGroupBy || "none");
  } catch (_e) {
    console.warn("[library] loadPrefs failed:", _e);
  }
  try {
    const support = await window.api.scanner.ocrSupport();
    STATE.prefs.ocrSupported = Boolean(support?.supported);
    STATE.prefs.ocrPlatform = String(support?.platform || "unknown");
    STATE.prefs.ocrReason = String(support?.reason || "");
  } catch (_e) {
    console.warn("[library] ocrSupport check failed:", _e);
  }
}
