/**
 * Управление LanceDB-таблицами (= коллекциями в наследии Chroma).
 *
 * Заменяет `electron/lib/chroma/collection-config.ts` + `collection-cache.ts`.
 *
 * Ключевые отличия от Chroma:
 *   - В LanceDB collection_id == name (нет UUID-redirection) → `collection-cache.ts`
 *     не нужен вовсе.
 *   - Distance metric выбирается per-query (не per-collection), но мы держим
 *     соглашение Bibliary: всё всегда cosine (multilingual-e5-small уже
 *     L2-нормализован).
 *   - HNSW-index создаётся отдельным вызовом `createIndex()` после первой
 *     волны upsert'ов (lazy). До индекса LanceDB делает brute-force scan —
 *     это корректно, просто медленнее.
 *
 * Concurrency: создание/удаление table сериализуются через `KeyedAsyncMutex`
 * в `points.ts` (тот же ключ что и для writer'а — нельзя ronать ensure
 * параллельно с upsert'ом в туже таблицу).
 */

import * as lancedb from "@lancedb/lancedb";

import { getDb } from "./connection.js";
import { buildConceptSchema } from "./schema.js";
import { withTableWriteLock } from "./locks.js";

export type VectorDistance = "cosine" | "l2" | "dot";

export interface VectorHnswConfig {
  /** Edges per node. Default 24 (как в Chroma config). */
  m?: number;
  /** Neighbors during construction. Default 128. */
  constructionEf?: number;
}

export interface EnsureCollectionSpec {
  name: string;
  /** Distance type для HNSW индекса. Default cosine. */
  distance?: VectorDistance;
  /** HNSW parameters. */
  hnsw?: VectorHnswConfig;
  /**
   * Lazy-build threshold: HNSW индекс ставится после того, как в таблице
   * накопилось ≥ `indexAfterRows`. Default 1024 — на меньших таблицах
   * brute-force быстрее чем cost индексирования.
   */
  indexAfterRows?: number;
}

export interface EnsureCollectionResult {
  name: string;
  /** true — table только что создан в этом вызове. */
  created: boolean;
  /** true — vector index уже существовал (или его не успели поставить лениво). */
  hasVectorIndex: boolean;
}

export interface CollectionInfo {
  name: string;
  /** Текущее число строк (countRows). Может быть медленный на huge tables. */
  rowCount: number;
  /** true если HNSW (или любой vector) индекс существует. */
  hasVectorIndex: boolean;
}

const DEFAULT_HNSW_M = 24;
const DEFAULT_HNSW_CONSTRUCTION_EF = 128;
const DEFAULT_INDEX_AFTER_ROWS = 1024;

/**
 * Выполнить идемпотентную проверку таблицы:
 *   - Существует? Открываем.
 *   - Не существует? Создаём с заданной schema, без данных.
 *   - Index есть? Возвращаем `hasVectorIndex: true`.
 *   - Index нет, и rows >= indexAfterRows? Создаём индекс.
 */
export async function ensureCollection(
  spec: EnsureCollectionSpec,
): Promise<EnsureCollectionResult> {
  const indexAfterRows = spec.indexAfterRows ?? DEFAULT_INDEX_AFTER_ROWS;

  return withTableWriteLock(spec.name, async () => {
    const db = await getDb();
    const existingNames = await db.tableNames();
    let table: lancedb.Table;
    let created = false;

    if (existingNames.includes(spec.name)) {
      table = await db.openTable(spec.name);
    } else {
      /* Empty table с явной schema — без данных. LanceDB v0.21 принимает
       * schema через options. Если ваша версия требует data + schema, см.
       * также примеры в их docs: createEmptyTable. */
      table = await db.createEmptyTable(spec.name, buildConceptSchema(), {
        existOk: true,
      });
      created = true;
    }

    const indices = await table.listIndices();
    const hasVectorIndex = indices.some((idx) => idx.columns?.includes("vector"));

    if (!hasVectorIndex) {
      const rowCount = await table.countRows();
      if (rowCount >= indexAfterRows) {
        await createVectorIndex(table, spec);
        return { name: spec.name, created, hasVectorIndex: true };
      }
    }

    return { name: spec.name, created, hasVectorIndex };
  });
}

async function createVectorIndex(
  table: lancedb.Table,
  spec: EnsureCollectionSpec,
): Promise<void> {
  const distance = spec.distance ?? "cosine";
  const m = spec.hnsw?.m ?? DEFAULT_HNSW_M;
  const efc = spec.hnsw?.constructionEf ?? DEFAULT_HNSW_CONSTRUCTION_EF;

  /* LanceDB Index API: пытаемся HNSW (cosine). Если SDK-версия ещё не
   * экспортирует hnsw напрямую, fallback на простой createIndex без
   * detailed config — он всё равно построит approximate-index по vector
   * column'е. */
  try {
    await table.createIndex("vector", {
      config: lancedb.Index.hnswPq({
        m,
        efConstruction: efc,
        distanceType: distance,
      }),
    });
  } catch (err) {
    /* Fallback — простой index без advanced config. Worst case: brute-force
     * scan останется до тех пор, пока пользователь не обновит SDK. Не валим
     * приложение из-за неподдерживаемой опции. */
    console.warn(
      `[vectordb] hnswPq index creation failed (${err instanceof Error ? err.message : String(err)}); falling back to default createIndex`,
    );
    try {
      await table.createIndex("vector");
    } catch (innerErr) {
      console.warn(
        `[vectordb] default createIndex also failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}; will retry on next ensureCollection`,
      );
    }
  }
}

/** Список всех известных tables в connection. */
export async function listCollections(): Promise<string[]> {
  const db = await getDb();
  return db.tableNames();
}

/**
 * Подробная информация по одной коллекции. На несуществующей —
 * возвращает `null` (caller покажет «collection not found» в UI).
 */
export async function getCollectionInfo(name: string): Promise<CollectionInfo | null> {
  const db = await getDb();
  const names = await db.tableNames();
  if (!names.includes(name)) return null;
  const table = await db.openTable(name);
  const [rowCount, indices] = await Promise.all([table.countRows(), table.listIndices()]);
  return {
    name,
    rowCount,
    hasVectorIndex: indices.some((idx) => idx.columns?.includes("vector")),
  };
}

/** true если collection существует. Удобно для probe-checks. */
export async function collectionExists(name: string): Promise<boolean> {
  const db = await getDb();
  const names = await db.tableNames();
  return names.includes(name);
}

/** Удалить collection целиком. Идемпотентно: на несуществующей — no-op. */
export async function deleteCollection(name: string): Promise<{ deleted: boolean }> {
  return withTableWriteLock(name, async () => {
    const db = await getDb();
    const names = await db.tableNames();
    if (!names.includes(name)) return { deleted: false };
    await db.dropTable(name);
    return { deleted: true };
  });
}

/**
 * Открыть table — internal helper для других модулей `vectordb/`. Throws
 * если таблицы нет (caller обязан был вызвать `ensureCollection` сначала).
 */
export async function openTable(name: string): Promise<lancedb.Table> {
  const db = await getDb();
  const names = await db.tableNames();
  if (!names.includes(name)) {
    throw new Error(`[vectordb] table "${name}" does not exist; call ensureCollection first`);
  }
  return db.openTable(name);
}
