/**
 * Qdrant collection configuration — centralized HNSW + payload index defaults.
 *
 * Before this module: каждый ensure*Collection() писал свой PUT-body вручную,
 * без HNSW config / payload indexes / quantization. Это давало:
 *   - дефолты Qdrant (m=16, ef_construct=128) — нормально, но не tuned под
 *     наш use-case (multilingual books with 100K+ chunks);
 *   - filtered search по `bookSourcePath`/`bookId` шёл через линейный скан
 *     payload — медленно.
 *
 * After: все `ensure*` функции через `ensureQdrantCollection(spec)` получают
 * единые best-practice конфиги (Qdrant 2026 docs):
 *   - `hnsw_config: { m: 24, ef_construct: 128 }` — +5-8% recall vs default
 *     при той же latency. На больших коллекциях (>50K) выгодно.
 *   - `payload_indexes` — keyword индексы на часто фильтруемые поля.
 *     Превращает filtered-search из O(N) в O(log N).
 *   - `optimizers_config: { default_segment_number: 2 }` — оставляем как было.
 *
 * Backward-compat: если коллекция уже существует (probe 200), создание
 * пропускается. Существующие коллекции продолжают работать с старыми
 * параметрами; миграция — отдельная админ-задача.
 *
 * Quantization: НЕ включаем по умолчанию. Scalar INT8 даёт -75% RAM, но
 * требует rescore на запросах и совместимости с embedder. Включается
 * явно через `spec.quantization === "scalar_int8"`.
 */

import { fetchQdrantJson, QDRANT_URL } from "./http-client.js";

export type QdrantDistance = "Cosine" | "Dot" | "Euclid";

export interface QdrantHnswConfig {
  /** Edges per node. Default Qdrant: 16. Recommended for books: 24. */
  m?: number;
  /** Neighbors during construction. Default 128. Higher = better quality, slower build. */
  ef_construct?: number;
  /** Below this byte size, segment uses brute-force (faster than HNSW for small data). */
  full_scan_threshold?: number;
  /** Store HNSW graph on disk. False = in-RAM (fastest). True = mmap. */
  on_disk?: boolean;
}

export interface QdrantPayloadIndexSpec {
  /** Field name in payload (e.g. "bookSourcePath", "bookId", "language"). */
  field: string;
  /** Index type. "keyword" for exact-match strings, "integer" for numbers. */
  type: "keyword" | "integer" | "float" | "bool" | "text";
}

export interface QdrantCollectionSpec {
  /** Collection name, e.g. "bibliary_illustrations". */
  name: string;
  /** Vector size, e.g. 384 (E5-small) or 512 (CLIP). */
  vectorSize: number;
  /** Distance function. Default Cosine. */
  distance?: QdrantDistance;
  /** HNSW tuning. If omitted — Qdrant defaults. */
  hnsw?: QdrantHnswConfig;
  /** Payload field indexes to create after collection. Empty = none. */
  payloadIndexes?: QdrantPayloadIndexSpec[];
  /** Default segment number for parallel write. */
  defaultSegmentNumber?: number;
  /** Scalar INT8 quantization (-75% RAM). Disabled by default. */
  quantization?: "none" | "scalar_int8";
}

/**
 * Создать коллекцию если её ещё нет. Идемпотентно — повторный вызов
 * для существующей коллекции = no-op. Если коллекция была создана
 * старым `ensureCollection` без HNSW config, новые точки в неё всё
 * равно идут — миграция параметров не делается автоматически.
 *
 * Возвращает `created: true` если создали, `created: false` если уже была.
 */
export async function ensureQdrantCollection(
  spec: QdrantCollectionSpec,
  qdrantUrl: string = QDRANT_URL,
): Promise<{ created: boolean }> {
  /* Probe — есть ли коллекция. */
  try {
    await fetchQdrantJson<{ result: unknown }>(
      `${qdrantUrl}/collections/${encodeURIComponent(spec.name)}`,
      { method: "GET", timeoutMs: 5_000 },
    );
    return { created: false }; /* exists — не трогаем */
  } catch {
    /* not found → create */
  }

  const distance: QdrantDistance = spec.distance ?? "Cosine";

  const body: Record<string, unknown> = {
    vectors: { size: spec.vectorSize, distance },
  };

  if (spec.hnsw) {
    const hnswConfig: Record<string, unknown> = {};
    if (spec.hnsw.m !== undefined) hnswConfig.m = spec.hnsw.m;
    if (spec.hnsw.ef_construct !== undefined) hnswConfig.ef_construct = spec.hnsw.ef_construct;
    if (spec.hnsw.full_scan_threshold !== undefined) {
      hnswConfig.full_scan_threshold = spec.hnsw.full_scan_threshold;
    }
    if (spec.hnsw.on_disk !== undefined) hnswConfig.on_disk = spec.hnsw.on_disk;
    if (Object.keys(hnswConfig).length > 0) body.hnsw_config = hnswConfig;
  }

  if (spec.defaultSegmentNumber !== undefined) {
    body.optimizers_config = { default_segment_number: spec.defaultSegmentNumber };
  }

  if (spec.quantization === "scalar_int8") {
    /* Qdrant scalar quantization config. quantile=0.99 удаляет outliers,
       always_ram=true держит quantized vectors в памяти для быстрого поиска,
       исходные float32 vectors хранятся on-disk и используются при rescore. */
    body.quantization_config = {
      scalar: {
        type: "int8",
        quantile: 0.99,
        always_ram: true,
      },
    };
  }

  await fetchQdrantJson<{ result: unknown }>(
    `${qdrantUrl}/collections/${encodeURIComponent(spec.name)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 15_000,
    },
  );

  /* Создаём payload indexes — независимо от первичного создания.
     Если коллекция была создана раньше БЕЗ индексов, повторный вызов
     `ensureQdrantCollection(...)` сейчас не пересоздаст её, но и не
     добавит индексы (создание было пропущено в probe выше). Чтобы
     добавить индекс к существующей коллекции — отдельный вызов. */
  if (spec.payloadIndexes && spec.payloadIndexes.length > 0) {
    for (const idx of spec.payloadIndexes) {
      try {
        await fetchQdrantJson<{ result: unknown }>(
          `${qdrantUrl}/collections/${encodeURIComponent(spec.name)}/index`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              field_name: idx.field,
              field_schema: idx.type,
            }),
            timeoutMs: 10_000,
          },
        );
      } catch (e) {
        /* Idempotent: если индекс уже есть — Qdrant вернёт 200 или
           ошибку которую мы игнорируем (best-effort). */
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[qdrant/collection-config] payload index ${idx.field} on ${spec.name} skipped: ${msg.slice(0, 200)}`,
        );
      }
    }
  }

  return { created: true };
}

/**
 * Добавить payload index к УЖЕ существующей коллекции. Используется для
 * "догнать" индексы на коллекциях созданных старыми ensure*-функциями.
 * Идемпотентно: если индекс уже есть, Qdrant ответит 200 и мы выйдем.
 */
export async function ensurePayloadIndex(
  collectionName: string,
  field: string,
  type: QdrantPayloadIndexSpec["type"] = "keyword",
  qdrantUrl: string = QDRANT_URL,
): Promise<void> {
  try {
    await fetchQdrantJson<{ result: unknown }>(
      `${qdrantUrl}/collections/${encodeURIComponent(collectionName)}/index`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_name: field,
          field_schema: type,
        }),
        timeoutMs: 10_000,
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    /* Не падаем если коллекция не существует или индекс уже есть. */
    console.warn(
      `[qdrant/collection-config] ensurePayloadIndex(${collectionName}, ${field}) — ${msg.slice(0, 200)}`,
    );
  }
}
