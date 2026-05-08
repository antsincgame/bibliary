/**
 * Низкоуровневые операции с точками LanceDB-таблицы (upsert / delete /
 * count / queryNearest).
 *
 * Заменяет `electron/lib/chroma/points.ts` 1:1 в названии экспортов:
 *   chromaUpsert            → vectorUpsert
 *   chromaUpsertAdaptive    → vectorUpsertAdaptive
 *   chromaDeleteByWhere     → vectorDeleteByWhere
 *   chromaCount             → vectorCount
 *   chromaQueryNearest      → vectorQueryNearest
 *   chromaDistanceToCosine  → distanceToCosine
 *
 * Ключевые отличия от Chroma:
 *   - **Arrow strict typing**: `canonicalizeRow` проецирует input на полный
 *     список колонок схемы, подставляет `null` для пропущенных. Без этого
 *     первая row с пропущенным полем уронит mergeInsert.
 *   - **`extraJson` catch-all**: ключи метаданных, которых нет в схеме,
 *     слипаются в один JSON-string. Forward-compat для будущих полей.
 *   - **single-writer-per-table** через `withTableWriteLock`. Concurrent
 *     reads (queryNearest, count) лочка не нужна.
 *   - **distance → cosine similarity**: LanceDB отдаёт `_distance` как cosine
 *     distance (1 - similarity) когда индекс настроен на cosine; для l2/dot
 *     конвертация та же что и в Chroma (chromaDistanceToCosine).
 */

import { makeArrowTable } from "@lancedb/lancedb";

import { openTable } from "./store.js";
import { withTableWriteLock } from "./locks.js";
import { chromaWhereToLance } from "./filter.js";
import { buildConceptSchema, METADATA_FIELDS, SCHEMA_VERSION, VECTOR_DIM } from "./schema.js";

/* ─── Public types — минимально совместимы с chroma-эпохой ────────── */

export type VectorScalar = string | number | boolean | null;
export type VectorMetadata = Record<string, unknown>;

export interface VectorPoint {
  id: string;
  embedding: number[] | Float32Array;
  metadata: VectorMetadata;
  document?: string;
}

export interface VectorNearestNeighbor {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  /** Cosine similarity ∈ [-1..1]. 1 = идентичны. */
  similarity: number;
}

/* ─── sanitizeMetadata — публичный, для caller'ов ──────────────────── */

/**
 * Coerce metadata value к LanceDB-acceptable форме. По сравнению с
 * Chroma sanitizer'ом мы можем держать nullable Utf8 поля → null
 * допустим. Но для tagsCsv держим pipe-границы для совместимости с
 * Chroma-эра кодом который мог писать `LIKE '%|tag|%'` и для будущих
 * full-text фильтров.
 *
 *   null/undefined  → null (Arrow nullable принимает)
 *   string[]        → "|t1|t2|"
 *   bigint          → Number(value) (loss of precision OK для metadata)
 *   Date            → ISO string
 *   other arr/obj   → JSON.stringify
 */
export function sanitizeMetadataValue(value: unknown): VectorScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
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

export function sanitizeMetadata(raw: Record<string, unknown>): Record<string, VectorScalar> {
  const out: Record<string, VectorScalar> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = sanitizeMetadataValue(v);
  }
  return out;
}

/* ─── Row canonicalization (KEY safety mechanism) ─────────────────── */

/**
 * Spread input metadata на full schema column list, дополнить null'ами,
 * остальное — в `extraJson`. Эта функция ДОЛЖНА вызываться перед каждым
 * upsert'ом (включая adaptive split-pages), иначе Arrow упадёт на первой
 * row с пропущенным полем.
 *
 * Возвращает плоский row-object готовый к Arrow encoding'у.
 */
export function canonicalizeRow(point: VectorPoint): Record<string, unknown> {
  const sanitized = sanitizeMetadata(point.metadata ?? {});
  const row: Record<string, unknown> = {
    id: String(point.id),
    /* PLAIN number[] обязательно — не Float32Array. LanceDB makeArrowTable
     * рекурсирует в любой не-Array object (Float32Array — это object,
     * не Array.isArray) и разворачивает в `vector.0`, `vector.1`, ...,
     * после чего схема не сходится. См. arrow.js:rowPathsAndValues. */
    vector: toPlainArray(point.embedding),
    document: typeof point.document === "string" ? point.document : "",
    schemaVersion: SCHEMA_VERSION,
    cursor_id: null, /* assigned by upsert step */
  };

  /* Заполнить все известные metadata-колонки nullable null'ами */
  for (const field of METADATA_FIELDS) {
    row[field] = field in sanitized ? sanitized[field] : null;
  }

  /* Catch-all: всё, чего нет в METADATA_FIELDS, идёт в extraJson —
   * включая isFictionOrWater (boolean), любые future-поля, custom user
   * metadata. Symmetric распаковка в `extractMetadataFromRow` ниже. */
  const known = new Set(METADATA_FIELDS);
  const extras: Record<string, VectorScalar> = {};
  for (const [k, v] of Object.entries(sanitized)) {
    if (!known.has(k)) extras[k] = v;
  }
  row.extraJson = Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;

  return row;
}

function toPlainArray(emb: number[] | Float32Array): number[] {
  if (emb instanceof Float32Array) {
    if (emb.length !== VECTOR_DIM) {
      throw new Error(`[vectordb] embedding dim mismatch: got ${emb.length}, expected ${VECTOR_DIM}`);
    }
    return Array.from(emb);
  }
  if (!Array.isArray(emb) || emb.length !== VECTOR_DIM) {
    throw new Error(`[vectordb] embedding must be array of length ${VECTOR_DIM} (got ${Array.isArray(emb) ? emb.length : typeof emb})`);
  }
  return emb;
}

/* ─── upsert ───────────────────────────────────────────────────────── */

/**
 * Upsert батч точек в таблицу. Idempotent через `mergeInsert` на `id`.
 *
 * Caller обязан вызвать `ensureCollection({name})` ДО первого upsert'а.
 */
export async function vectorUpsert(
  collectionName: string,
  points: VectorPoint[],
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (points.length === 0) return;
  if (options?.signal?.aborted) throw new Error("[vectordb] upsert aborted");

  const rows = points.map(canonicalizeRow);

  /* Без явной schema makeArrowTable вызывает inferSchema, который для
   * vector-колонки (number[] of dim 384) разворачивает её в поля
   * `vector.0`, `vector.1`, ... и валится с "field not in schema".
   * Pre-encode через makeArrowTable со схемой → получаем правильно
   * типизированную FixedSizeList<Float32, 384> колонку. */
  const arrowTable = makeArrowTable(rows, { schema: buildConceptSchema() });

  /* Upsert через delete-then-add: вместо mergeInsert (который в некоторых
   * Lance-environments падает с «Spill has sent an error» на пустых
   * таблицах из-за temp-spill setup'а), делаем явное удаление существующих
   * id'шек и затем append. Корректно эмулирует upsert и работает на любом
   * Lance backend'е. Per-table mutex гарантирует, что между delete и add
   * никто не вклинится. */
  const ids = points.map((p) => String(p.id));
  const idLiterals = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
  const deletePredicate = `id IN (${idLiterals})`;

  await withTableWriteLock(collectionName, async () => {
    const table = await openTable(collectionName);
    /* На пустой таблице delete на несуществующих id — no-op; на повторном
     * upsert же — стирает старую row с этим id. */
    await table.delete(deletePredicate);
    await table.add(arrowTable);
  });
}

/**
 * Adaptive upsert с binary backoff. Если batch упадёт (например slow
 * disk + memory pressure → arrow encode error), делим пополам и пробуем
 * снова. Достигаем minimum=1 — если single point всё ещё падает, бросаем.
 */
export async function vectorUpsertAdaptive(
  collectionName: string,
  points: VectorPoint[],
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (points.length === 0) return;
  try {
    await vectorUpsert(collectionName, points, options);
  } catch (err) {
    if (points.length <= 1) throw err;
    const mid = Math.ceil(points.length / 2);
    await vectorUpsertAdaptive(collectionName, points.slice(0, mid), options);
    await vectorUpsertAdaptive(collectionName, points.slice(mid), options);
  }
}

/* ─── delete ───────────────────────────────────────────────────────── */

export interface DeleteResult {
  /** LanceDB не возвращает count удалённых из delete API — фиксируем это
   * явно: caller, которому нужен count, должен сделать count ДО + count ПОСЛЕ. */
  ok: true;
}

/**
 * Удалить точки по metadata-фильтру (Chroma-style `where` объект).
 * Идемпотентно: на матч-нет — no-op без ошибок.
 */
export async function vectorDeleteByWhere(
  collectionName: string,
  where: Record<string, unknown>,
  _options?: { signal?: AbortSignal },
): Promise<DeleteResult> {
  const predicate = chromaWhereToLance(where);
  if (!predicate) {
    /* Без фильтра удалять опасно — бросаем, чтобы caller не удалил всю
     * таблицу by accident. Если действительно нужно очистить — есть
     * отдельный deleteCollection(). */
    throw new Error(`[vectordb] vectorDeleteByWhere refuses empty filter; use deleteCollection() to wipe`);
  }
  await withTableWriteLock(collectionName, async () => {
    const table = await openTable(collectionName);
    await table.delete(predicate);
  });
  return { ok: true };
}

/* ─── count ────────────────────────────────────────────────────────── */

export async function vectorCount(collectionName: string): Promise<number> {
  const table = await openTable(collectionName);
  return table.countRows();
}

/* ─── query nearest ────────────────────────────────────────────────── */

export type DistanceSpace = "cosine" | "l2" | "dot";

/**
 * Преобразовать LanceDB distance в cosine similarity.
 * Семантика та же что в `chromaDistanceToCosine`:
 *   - cosine: similarity = 1 - distance
 *   - l2 для unit-vectors: ||a-b||² = 2·(1-cos) → cos = 1 - d/2
 *   - dot/ip: similarity == dot product == -distance
 */
export function distanceToCosine(distance: number, space: DistanceSpace): number {
  if (!Number.isFinite(distance)) return 0;
  if (space === "cosine") return 1 - distance;
  if (space === "l2") return 1 - distance / 2;
  return -distance;
}

export async function vectorQueryNearest(
  collectionName: string,
  embedding: number[] | Float32Array,
  n: number = 3,
  options?: {
    signal?: AbortSignal;
    where?: Record<string, unknown>;
    /** Default "cosine". Должен совпадать с тем что был задан в `ensureCollection`. */
    space?: DistanceSpace;
  },
): Promise<VectorNearestNeighbor[]> {
  if (n <= 0) return [];
  if (options?.signal?.aborted) throw new Error("[vectordb] queryNearest aborted");

  const table = await openTable(collectionName);
  const queryVector = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
  if (queryVector.length !== VECTOR_DIM) {
    throw new Error(`[vectordb] query embedding dim mismatch: got ${queryVector.length}, expected ${VECTOR_DIM}`);
  }
  const space: DistanceSpace = options?.space ?? "cosine";

  /* `vectorSearch()` гарантирует return-type VectorQuery (с distanceType()),
   * против полиморфного `search()` который может вернуть VectorQuery|Query. */
  let q = table.vectorSearch(queryVector).distanceType(space).limit(n);
  if (options?.where) {
    const predicate = chromaWhereToLance(options.where);
    if (predicate) q = q.where(predicate);
  }

  const rows = (await q.toArray()) as Array<Record<string, unknown> & { _distance?: number }>;

  return rows.map((row) => {
    const distance = typeof row._distance === "number" ? row._distance : 0;
    const metadata = extractMetadataFromRow(row);
    return {
      id: String(row.id ?? ""),
      document: typeof row.document === "string" ? row.document : "",
      metadata,
      similarity: distanceToCosine(distance, space),
    };
  });
}

/**
 * Извлечь plain metadata-объект из LanceDB row'а: METADATA_FIELDS +
 * isFictionOrWater + распаковать `extraJson`. Symmetric с canonicalizeRow.
 */
function extractMetadataFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of METADATA_FIELDS) {
    if (row[field] !== null && row[field] !== undefined) out[field] = row[field];
  }
  if (typeof row.extraJson === "string" && row.extraJson.length > 0) {
    try {
      const parsed = JSON.parse(row.extraJson) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (!(k in out)) out[k] = v;
      }
    } catch { /* ignore — extraJson invalid, поле не вернётся в metadata */ }
  }
  return out;
}

/* ─── Re-exports для backward-compat call site'ов ──────────────────── */

export { whereExact, whereAnyOf, whereAllOf } from "./filter.js";
