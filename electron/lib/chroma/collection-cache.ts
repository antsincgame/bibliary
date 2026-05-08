/**
 * Кэш `name → id` для Chroma коллекций.
 *
 * Зачем: Chroma REST API использует **collection name** для CRUD коллекций
 * (create/list/delete/info), но **UUID `collection_id`** для всех точек-операций
 * (upsert/get/query/delete). Каждый upsert требует id, а лишний lookup на
 * каждый batch — это лишний HTTP roundtrip.
 *
 * Решение: lazy in-memory `Map<name, id>`. Заполняется при первом запросе
 * (GET /api/v1/collections/{name}), инвалидируется при delete или ручном вызове
 * `invalidate()`. Single-process scope — main process единственный потребитель.
 */

import { chromaUrl, fetchChromaJson } from "./http-client.js";

interface ChromaCollectionInfo {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

const cache = new Map<string, string>();
const metadataCache = new Map<string, Record<string, unknown>>();

/**
 * Получить `collection_id` по имени. Если нет в кэше — fetch и сохранить.
 * Бросает ошибку если коллекция не существует (404 от Chroma) — caller
 * должен сначала `ensureChromaCollection()`.
 */
export async function resolveCollectionId(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;
  const info = await fetchChromaJson<ChromaCollectionInfo>(
    chromaUrl(`/collections/${encodeURIComponent(name)}`),
    { method: "GET", timeoutMs: 5_000 },
  );
  if (!info?.id) {
    throw new Error(`Chroma: collection "${name}" has no id`);
  }
  cache.set(name, info.id);
  if (info.metadata) metadataCache.set(name, info.metadata);
  return info.id;
}

/**
 * Получить hnsw:space коллекции — нужен для distance→similarity конвертации
 * в `chromaQueryNearest`. Кэшируется тем же fetch'ем, что и id. Default
 * "cosine" при отсутствии метаданных (Bibliary всегда создаёт коллекции с
 * `hnsw:space=cosine`, см. collection-config.ts).
 */
export async function getCollectionSpace(name: string): Promise<"cosine" | "l2" | "ip"> {
  if (!metadataCache.has(name)) {
    /* Прогреваем кэш: resolveCollectionId как побочка кладёт metadata. */
    await resolveCollectionId(name);
  }
  const md = metadataCache.get(name);
  const raw = md?.["hnsw:space"];
  if (raw === "l2" || raw === "ip" || raw === "cosine") return raw;
  return "cosine";
}

/** Удалить кэшированное mapping для имени. Вызывается после delete-collection. */
export function invalidate(name: string): void {
  cache.delete(name);
  metadataCache.delete(name);
}

/** Полностью очистить кэш. Используется в тестах и при app shutdown. */
export function clearAll(): void {
  cache.clear();
  metadataCache.clear();
}

/** Принудительно записать mapping (используется когда id уже известен из create-response). */
export function setMapping(name: string, id: string, metadata?: Record<string, unknown> | null): void {
  if (typeof name === "string" && typeof id === "string" && name.length > 0 && id.length > 0) {
    cache.set(name, id);
    if (metadata) metadataCache.set(name, metadata);
  }
}

/** Только для тестов: snapshot текущего состояния. */
export function _snapshotForTesting(): Record<string, string> {
  return Object.fromEntries(cache.entries());
}
