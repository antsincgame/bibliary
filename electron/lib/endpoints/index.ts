/**
 * Single source of truth for the URLs of external services Bibliary
 * connects to (LM Studio, Chroma). Resolution order, highest first:
 *
 *   1. User preference (`preferences.lmStudioUrl` / `preferences.chromaUrl`)
 *      saved via the Settings UI.
 *   2. Process environment (`LM_STUDIO_URL` / `CHROMA_URL`) -- kept for
 *      CLI scripts and CI.
 *   3. Hard-coded localhost defaults.
 *
 * Why this exists: previously each module read `process.env.X` directly
 * and the user had no UI to point Bibliary at a remote Chroma or to a
 * non-default LM Studio port -- they had to set env vars and restart.
 * The cache is invalidated automatically on every `preferences:set` /
 * `preferences:reset` (see `electron/ipc/preferences.ipc.ts`).
 */

import { getPreferencesStore } from "../preferences/store.js";

const ENV_LM_STUDIO_URL = process.env.LM_STUDIO_URL || "";
const ENV_CHROMA_URL = process.env.CHROMA_URL || "";

/** Дефолты экспортируются, чтобы все дубликаты ("http://localhost:1234",
 *  "http://localhost:8000") в кодовой базе использовали этот единый
 *  source-of-truth. */
export const DEFAULT_LM_STUDIO_URL = "http://localhost:1234";
export const DEFAULT_CHROMA_URL = "http://localhost:8000";

interface UrlCache {
  lmStudio: string;
  chroma: string;
  loadedFrom: "prefs" | "env" | "default";
}

let cache: UrlCache | null = null;

/** Force-refresh from preferences. Called by preferences IPC on set/reset. */
export function invalidateEndpointsCache(): void {
  cache = null;
}

function trim(url: string | undefined | null): string {
  return typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
}

/**
 * Resolve both URLs in one go (saves a roundtrip to the prefs store
 * when both endpoints are needed in the same handler).
 */
export async function getEndpoints(): Promise<{ lmStudioUrl: string; chromaUrl: string }> {
  if (cache) return { lmStudioUrl: cache.lmStudio, chromaUrl: cache.chroma };
  let prefsLm = "";
  let prefsCh = "";
  try {
    const prefs = await getPreferencesStore().getAll();
    prefsLm = trim(prefs.lmStudioUrl);
    prefsCh = trim(prefs.chromaUrl);
  } catch {
    /* store not yet initialised (very early boot) -- fall back to env */
  }
  const lmStudio = prefsLm || trim(ENV_LM_STUDIO_URL) || DEFAULT_LM_STUDIO_URL;
  const chroma = prefsCh || trim(ENV_CHROMA_URL) || DEFAULT_CHROMA_URL;
  const loadedFrom: UrlCache["loadedFrom"] = prefsLm || prefsCh
    ? "prefs"
    : (ENV_LM_STUDIO_URL || ENV_CHROMA_URL ? "env" : "default");
  cache = { lmStudio, chroma, loadedFrom };
  return { lmStudioUrl: lmStudio, chromaUrl: chroma };
}

export async function getLmStudioUrl(): Promise<string> {
  return (await getEndpoints()).lmStudioUrl;
}

export async function getChromaUrl(): Promise<string> {
  return (await getEndpoints()).chromaUrl;
}

/**
 * Synchronous read of the LAST resolved value. Returns the default if
 * `getEndpoints()` was never called. Useful for low-frequency module
 * boot-time globals where async access is awkward; always prefer the
 * async getters in new code.
 */
export function getLmStudioUrlSync(): string {
  /* `||` (не `??`) -- trim() возвращает "" для пустого env, а `??` пропускает
     пустую строку (она не nullish), что приводит к `LMStudioClient({baseUrl:""})`
     и падению "Invalid baseUrl". */
  return cache?.lmStudio || trim(ENV_LM_STUDIO_URL) || DEFAULT_LM_STUDIO_URL;
}

export function getChromaUrlSync(): string {
  return cache?.chroma || trim(ENV_CHROMA_URL) || DEFAULT_CHROMA_URL;
}
