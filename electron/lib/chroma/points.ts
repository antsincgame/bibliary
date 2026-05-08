/**
 * Низкоуровневые операции с точками Chroma коллекции (upsert / delete / count).
 *
 * Делает подъём `name → id` через collection-cache, поэтому caller передаёт
 * **имя** коллекции (как в Chroma-эпохе) — это снижает ребус миграции в
 * остальном коде. Если коллекция не существует — caller должен сначала
 * вызвать `ensureChromaCollection()`.
 */

import { chromaUrl, fetchChromaJson, CHROMA_TIMEOUT_MS } from "./http-client.js";
import { resolveCollectionId, getCollectionSpace } from "./collection-cache.js";

/**
 * Метаданные точки. Chroma принимает ТОЛЬКО скаляры (string|number|boolean).
 * `null` запрещён в некоторых версиях Chroma — sanitizeMetadata coerce'ит в "".
 * Массивы/объекты caller должен сериализовать сам (см. sanitizeMetadataValue).
 */
export type ChromaScalar = string | number | boolean;
export type ChromaMetadata = Record<string, ChromaScalar>;

export interface ChromaPoint {
  /** ID — должен быть строкой. Caller обязан coerce: `String(id)`. */
  id: string;
  /** Float32Array или number[] — pre-computed embedding. */
  embedding: number[] | Float32Array;
  /** Metadata — только скаляры. Используйте sanitizeMetadataValue перед записью. */
  metadata: ChromaMetadata;
  /** Текст документа — first-class в Chroma (поддерживает full-text search). */
  document?: string;
}

/**
 * Coerce metadata value to Chroma-acceptable scalar.
 *  - null/undefined → "" (Chroma OSS не принимает null в metadata)
 *  - string[]      → "|tag1|tag2|" (для $contains-фильтрации с pipe-границами)
 *  - other arrays/objects → JSON.stringify
 *  - bigint        → Number(value) (с потерей точности — приемлемо для метаданных)
 *  - Date          → ISO string
 */
export function sanitizeMetadataValue(value: unknown): ChromaScalar {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) {
      return `|${(value as string[]).join("|")}|`;
    }
    return JSON.stringify(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Применить sanitize ко всем значениям объекта. */
export function sanitizeMetadata(raw: Record<string, unknown>): ChromaMetadata {
  const out: ChromaMetadata = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = sanitizeMetadataValue(v);
  }
  return out;
}

interface ChromaUpsertBody {
  ids: string[];
  embeddings: number[][];
  metadatas: ChromaMetadata[];
  documents: string[];
}

/**
 * Upsert батч точек в Chroma. Idempotent: повторный вызов с теми же `ids`
 * перезаписывает (без duplicate-ошибок).
 *
 * Body shape: parallel arrays ({ids, embeddings, metadatas, documents}) —
 * это canonical Chroma pattern, отличается от Chroma `{points:[…]}`.
 *
 * Защитные преобразования:
 *  - `String(point.id)` — Chroma строго требует string IDs;
 *  - Float32Array → Array.from() для JSON.stringify;
 *  - sanitizeMetadata() для null/array/object coercion;
 *  - text → documents[] (first-class chunk storage).
 */
export async function chromaUpsert(
  collectionName: string,
  points: ChromaPoint[],
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  if (points.length === 0) return;
  const collectionId = await resolveCollectionId(collectionName);

  const body: ChromaUpsertBody = {
    ids: points.map((p) => String(p.id)),
    embeddings: points.map((p) => (p.embedding instanceof Float32Array ? Array.from(p.embedding) : Array.from(p.embedding))),
    metadatas: points.map((p) => p.metadata),
    documents: points.map((p) => p.document ?? ""),
  };

  await fetchChromaJson<unknown>(
    chromaUrl(`/collections/${encodeURIComponent(collectionId)}/upsert`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: options?.timeoutMs ?? CHROMA_TIMEOUT_MS,
      signal: options?.signal,
    },
  );
}

/**
 * Adaptive upsert с binary backoff. Если batch падает (например HTTP 413
 * payload-too-large), делим пополам и пробуем снова. Достигаем minimum batch=1
 * — если single point всё ещё падает, бросаем.
 */
export async function chromaUpsertAdaptive(
  collectionName: string,
  points: ChromaPoint[],
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  if (points.length === 0) return;
  try {
    await chromaUpsert(collectionName, points, options);
    return;
  } catch (err) {
    if (points.length <= 1) throw err;
    const mid = Math.ceil(points.length / 2);
    await chromaUpsertAdaptive(collectionName, points.slice(0, mid), options);
    await chromaUpsertAdaptive(collectionName, points.slice(mid), options);
  }
}

/**
 * Удалить точки по metadata-фильтру (Chroma `where`).
 *
 * Примеры `where`:
 *   { bookId: "abc-123" }                              — exact match
 *   { bookSourcePath: { $eq: "/path/to/x.epub" } }     — explicit eq
 *   { $or: [{ bookId: "x" }, { bookSourcePath: "y" }]} — OR
 *   { $and: [{ bookId: "x" }, { chunkIndex: 0 }] }     — AND
 */
export async function chromaDeleteByWhere(
  collectionName: string,
  where: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ deleted: number }> {
  const collectionId = await resolveCollectionId(collectionName);
  /* Chroma возвращает массив удалённых ids. */
  const result = await fetchChromaJson<string[] | { ids?: string[] } | null>(
    chromaUrl(`/collections/${encodeURIComponent(collectionId)}/delete`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ where }),
      timeoutMs: options?.timeoutMs ?? CHROMA_TIMEOUT_MS,
      signal: options?.signal,
    },
  );
  const ids = Array.isArray(result) ? result : (result?.ids ?? []);
  return { deleted: ids.length };
}

/** Получить количество точек в коллекции. */
export async function chromaCount(collectionName: string): Promise<number> {
  const collectionId = await resolveCollectionId(collectionName);
  const n = await fetchChromaJson<number>(
    chromaUrl(`/collections/${encodeURIComponent(collectionId)}/count`),
    { method: "GET", timeoutMs: 5_000 },
  );
  return typeof n === "number" ? n : 0;
}

/* ─────────────────────────────────────────────────────────────────────
 * Nearest-neighbor query — для uniqueness-evaluator и concept-dedup.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Преобразовать Chroma `distance` в cosine similarity ∈ [-1..1].
 *  - cosine space: distance = 1 - cosineSimilarity → similarity = 1 - d
 *  - l2 space: для нормализованных векторов ||a-b||² = 2·(1 - cosSim)
 *              ⇒ cosSim = 1 - d/2 (Chroma возвращает squared-L2)
 *  - ip space: distance = -dot, для нормализованных = -cosSim
 *              ⇒ cosSim = -d
 */
export function chromaDistanceToCosine(distance: number, space: "cosine" | "l2" | "ip"): number {
  if (!Number.isFinite(distance)) return 0;
  if (space === "cosine") return 1 - distance;
  if (space === "l2") return 1 - distance / 2;
  return -distance; /* ip */
}

export interface ChromaNearestNeighbor {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  /** Уже-конвертированный cosine similarity ∈ [-1..1], 1 = идентичны. */
  similarity: number;
}

interface ChromaQueryResponse {
  ids?: string[][] | null;
  distances?: number[][] | null;
  documents?: (string | null)[][] | null;
  metadatas?: (Record<string, unknown> | null)[][] | null;
}

/**
 * Найти top-N ближайших точек к данному эмбеддингу. Возвращает результаты
 * с уже-конвертированной cosine similarity (см. chromaDistanceToCosine).
 *
 * Внутри спрашиваем коллекцию о её `hnsw:space` (один раз через cache),
 * чтобы корректно перевести distance → similarity вне зависимости от того,
 * какая метрика выбрана при создании коллекции.
 *
 * Возвращает `[]` если коллекция пустая или query не вернул ничего.
 */
export async function chromaQueryNearest(
  collectionName: string,
  embedding: number[] | Float32Array,
  n: number = 3,
  options?: { signal?: AbortSignal; timeoutMs?: number; where?: Record<string, unknown> },
): Promise<ChromaNearestNeighbor[]> {
  if (n <= 0) return [];
  const collectionId = await resolveCollectionId(collectionName);
  const space = await getCollectionSpace(collectionName);

  const queryEmbedding = embedding instanceof Float32Array ? Array.from(embedding) : Array.from(embedding);

  const body: Record<string, unknown> = {
    query_embeddings: [queryEmbedding],
    n_results: n,
    include: ["documents", "distances", "metadatas"],
  };
  if (options?.where && Object.keys(options.where).length > 0) {
    body.where = options.where;
  }

  let response: ChromaQueryResponse;
  try {
    response = await fetchChromaJson<ChromaQueryResponse>(
      chromaUrl(`/collections/${encodeURIComponent(collectionId)}/query`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: options?.timeoutMs ?? CHROMA_TIMEOUT_MS,
        signal: options?.signal,
      },
    );
  } catch (err) {
    /* Пустая коллекция в некоторых версиях Chroma даёт HTTP 500 «no records».
       Не пробрасываем — uniqueness-evaluator должен трактовать пустую
       коллекцию как «всё NOVEL». */
    const msg = err instanceof Error ? err.message : String(err);
    if (/no records|empty|not enough/i.test(msg)) return [];
    throw err;
  }

  const ids = response.ids?.[0] ?? [];
  const distances = response.distances?.[0] ?? [];
  const documents = response.documents?.[0] ?? [];
  const metadatas = response.metadatas?.[0] ?? [];

  const out: ChromaNearestNeighbor[] = [];
  for (let i = 0; i < ids.length; i++) {
    const distance = typeof distances[i] === "number" ? (distances[i] as number) : 0;
    out.push({
      id: String(ids[i] ?? ""),
      document: String(documents[i] ?? ""),
      metadata: (metadatas[i] ?? {}) as Record<string, unknown>,
      similarity: chromaDistanceToCosine(distance, space),
    });
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────
 * Filter translation helpers — pure functions для Chroma `where`. No I/O.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Простой equality filter. `chromaWhereExact("bookId", "abc")` → `{bookId: "abc"}`.
 */
export function chromaWhereExact(field: string, value: string | number | boolean): Record<string, unknown> {
  return { [field]: value };
}

/**
 * `OR` через `$or` — несколько альтернативных условий.
 * Каждый matcher — `{field, value}`. Результат: `{$or: [{f1:v1},{f2:v2}]}`.
 */
export function chromaWhereAnyOf(matchers: Array<{ field: string; value: string | number | boolean }>): Record<string, unknown> {
  if (matchers.length === 0) return {};
  if (matchers.length === 1) return { [matchers[0].field]: matchers[0].value };
  return { $or: matchers.map((m) => ({ [m.field]: m.value })) };
}

/**
 * `AND` через `$and` — все условия должны выполняться.
 */
export function chromaWhereAllOf(matchers: Array<{ field: string; value: string | number | boolean }>): Record<string, unknown> {
  if (matchers.length === 0) return {};
  if (matchers.length === 1) return { [matchers[0].field]: matchers[0].value };
  return { $and: matchers.map((m) => ({ [m.field]: m.value })) };
}
