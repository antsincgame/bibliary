/**
 * Single source of truth for the URL of LM Studio (the only external
 * service Bibliary connects to). Resolution order, highest first:
 *
 *   1. User preference (`preferences.lmStudioUrl`) saved via Settings UI.
 *   2. Process environment (`LM_STUDIO_URL`) — kept for CLI scripts and CI.
 *   3. Hard-coded localhost default.
 *
 * Why this exists: previously each module read `process.env.X` directly
 * and the user had no UI to point Bibliary at a non-default LM Studio
 * port — they had to set env vars and restart. The cache is invalidated
 * automatically on every `preferences:set` / `preferences:reset` (see
 * `electron/ipc/preferences.ipc.ts`).
 *
 * **Chroma URL ушёл** в Phase 2 миграции на LanceDB. Vector store теперь
 * in-process, у него нет network endpoint'а — поэтому endpoints/* выдаёт
 * только `lmStudioUrl`.
 */

import { getPreferencesStore } from "../preferences/store.js";

/* Читаем env-var лениво при каждом обращении (а не один раз при загрузке
 * модуля). Это критично для CLI-скриптов и интеграционных тестов: код может
 * выставить `process.env.LM_STUDIO_URL` уже ПОСЛЕ загрузки модуля
 * (например, в test setup), и обещание из шапки файла «kept for CLI scripts
 * and CI» работает только при динамическом чтении. Чтение env — это hash
 * lookup, оверхеда нет. */
function readEnvLmStudioUrl(): string {
  return process.env.LM_STUDIO_URL || "";
}

export const DEFAULT_LM_STUDIO_URL = "http://localhost:1234";

interface UrlCache {
  lmStudio: string;
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

export async function getEndpoints(): Promise<{ lmStudioUrl: string }> {
  if (cache) return { lmStudioUrl: cache.lmStudio };
  let prefsLm = "";
  try {
    const prefs = await getPreferencesStore().getAll();
    prefsLm = trim(prefs.lmStudioUrl);
  } catch {
    /* store not yet initialised (very early boot) — fall back to env */
  }
  const lmStudio = prefsLm || trim(readEnvLmStudioUrl()) || DEFAULT_LM_STUDIO_URL;
  const loadedFrom: UrlCache["loadedFrom"] = prefsLm
    ? "prefs"
    : (readEnvLmStudioUrl() ? "env" : "default");
  cache = { lmStudio, loadedFrom };
  return { lmStudioUrl: lmStudio };
}

export async function getLmStudioUrl(): Promise<string> {
  return (await getEndpoints()).lmStudioUrl;
}

/**
 * Synchronous read of the LAST resolved value. Returns the default if
 * `getEndpoints()` was never called. Useful for low-frequency module
 * boot-time globals where async access is awkward; always prefer the
 * async getter in new code.
 */
export function getLmStudioUrlSync(): string {
  /* `||` (не `??`) — trim() возвращает "" для пустого env, а `??` пропускает
     пустую строку (она не nullish), что приводит к `LMStudioClient({baseUrl:""})`
     и падению "Invalid baseUrl". */
  return cache?.lmStudio || trim(readEnvLmStudioUrl()) || DEFAULT_LM_STUDIO_URL;
}
