/**
 * Single source of truth for the URLs of external services Bibliary
 * connects to (LM Studio, Qdrant). Resolution order, highest first:
 *
 *   1. User preference (`preferences.lmStudioUrl` / `preferences.qdrantUrl`)
 *      saved via the Settings UI.
 *   2. Process environment (`LM_STUDIO_URL` / `QDRANT_URL`) -- kept for
 *      CLI scripts and CI.
 *   3. Hard-coded localhost defaults.
 *
 * Why this exists: previously each module read `process.env.X` directly
 * and the user had no UI to point Bibliary at a remote Qdrant or to a
 * non-default LM Studio port -- they had to set env vars and restart.
 * The cache is invalidated automatically on every `preferences:set` /
 * `preferences:reset` (see `electron/ipc/preferences.ipc.ts`).
 */

import { getPreferencesStore } from "../preferences/store.js";

const ENV_LM_STUDIO_URL = process.env.LM_STUDIO_URL || "";
const ENV_QDRANT_URL = process.env.QDRANT_URL || "";

/** Дефолты экспортируются, чтобы все дубликаты ("http://localhost:1234",
 *  "http://localhost:6333") в кодовой базе использовали этот единый
 *  source-of-truth (Block A3, dedup). */
export const DEFAULT_LM_STUDIO_URL = "http://localhost:1234";
export const DEFAULT_QDRANT_URL = "http://localhost:6333";

interface UrlCache {
  lmStudio: string;
  qdrant: string;
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
export async function getEndpoints(): Promise<{ lmStudioUrl: string; qdrantUrl: string }> {
  if (cache) return { lmStudioUrl: cache.lmStudio, qdrantUrl: cache.qdrant };
  let prefsLm = "";
  let prefsQd = "";
  try {
    const prefs = await getPreferencesStore().getAll();
    prefsLm = trim(prefs.lmStudioUrl);
    prefsQd = trim(prefs.qdrantUrl);
  } catch {
    /* store not yet initialised (very early boot) -- fall back to env */
  }
  const lmStudio = prefsLm || trim(ENV_LM_STUDIO_URL) || DEFAULT_LM_STUDIO_URL;
  const qdrant = prefsQd || trim(ENV_QDRANT_URL) || DEFAULT_QDRANT_URL;
  const loadedFrom: UrlCache["loadedFrom"] = prefsLm || prefsQd
    ? "prefs"
    : (ENV_LM_STUDIO_URL || ENV_QDRANT_URL ? "env" : "default");
  cache = { lmStudio, qdrant, loadedFrom };
  return { lmStudioUrl: lmStudio, qdrantUrl: qdrant };
}

export async function getLmStudioUrl(): Promise<string> {
  return (await getEndpoints()).lmStudioUrl;
}

export async function getQdrantUrl(): Promise<string> {
  return (await getEndpoints()).qdrantUrl;
}

/**
 * Synchronous read of the LAST resolved value. Returns the default if
 * `getEndpoints()` was never called. Useful for low-frequency module
 * boot-time globals where async access is awkward (e.g. legacy
 * `QDRANT_URL` constant); always prefer the async getters in new code.
 */
export function getLmStudioUrlSync(): string {
  /* `||` (не `??`) -- trim() возвращает "" для пустого env, а `??` пропускает
     пустую строку (она не nullish), что приводит к `LMStudioClient({baseUrl:""})`
     и падению "Invalid baseUrl". */
  return cache?.lmStudio || trim(ENV_LM_STUDIO_URL) || DEFAULT_LM_STUDIO_URL;
}

export function getQdrantUrlSync(): string {
  return cache?.qdrant || trim(ENV_QDRANT_URL) || DEFAULT_QDRANT_URL;
}

