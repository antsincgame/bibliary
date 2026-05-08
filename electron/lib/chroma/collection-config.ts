/**
 * Chroma collection configuration — централизованные HNSW defaults.
 *
 * Chroma не имеет отдельного payload-index API — фильтрация по metadata
 * работает через встроенный механизм. HNSW параметры передаются как
 * метаданные коллекции при создании:
 *   - `hnsw:space` ∈ {"cosine", "l2", "ip"} — distance function
 *   - `hnsw:M` — рёбер на узел (default Chroma: 16; для книг рекомендуем 24)
 *   - `hnsw:construction_ef` — соседей при построении (default 100; ставим 128)
 *
 * Идемпотентность: используем `get_or_create:true` — если коллекция есть,
 * Chroma вернёт существующую без изменения metadata. Если HNSW config
 * расходится — выводим warning через `hnswMismatch` (не пересоздаём,
 * это привело бы к потере данных).
 */

import { chromaUrl, fetchChromaJson } from "./http-client.js";
import { setMapping } from "./collection-cache.js";

export type ChromaDistance = "cosine" | "l2" | "ip";

export interface ChromaHnswConfig {
  /** Edges per node. Chroma default: 16. Recommended for books: 24. */
  m?: number;
  /** Neighbors during construction. Chroma default: 100. We use 128. */
  construction_ef?: number;
}

export interface ChromaCollectionSpec {
  /** Collection name, e.g. "bibliary_books". */
  name: string;
  /** Distance function. Default cosine. */
  distance?: ChromaDistance;
  /** HNSW tuning. If omitted — Chroma defaults. */
  hnsw?: ChromaHnswConfig;
  /** Дополнительные пары metadata, кроме hnsw:* (например app-specific тэги). */
  userMetadata?: Record<string, string | number | boolean>;
}

/**
 * Собрать metadata-объект для create-call: hnsw:* поля + user-extra.
 */
function buildMetadata(spec: ChromaCollectionSpec): Record<string, string | number | boolean> {
  const md: Record<string, string | number | boolean> = {};
  md["hnsw:space"] = spec.distance ?? "cosine";
  if (spec.hnsw?.m !== undefined) md["hnsw:M"] = spec.hnsw.m;
  if (spec.hnsw?.construction_ef !== undefined) md["hnsw:construction_ef"] = spec.hnsw.construction_ef;
  if (spec.userMetadata) Object.assign(md, spec.userMetadata);
  return md;
}

/**
 * Сравнить желаемую vs фактическую metadata, вернуть список расхождений
 * (только для hnsw:* полей — userMetadata не проверяем, она может legitimately
 * меняться у разных создателей коллекции).
 */
function diffHnswMetadata(
  expected: Record<string, string | number | boolean>,
  actual: Record<string, unknown> | null | undefined,
): string[] {
  if (!actual) return [];
  const mismatches: string[] = [];
  for (const key of Object.keys(expected)) {
    if (!key.startsWith("hnsw:")) continue;
    const want = expected[key];
    const have = actual[key];
    if (have !== undefined && want !== have) {
      mismatches.push(`${key}: expected=${String(want)}, actual=${String(have)}`);
    }
  }
  return mismatches;
}

interface ChromaCollectionResponse {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Создать коллекцию если её ещё нет. Идемпотентно через `get_or_create:true`.
 * Если HNSW config существующей коллекции расходится с желаемым — возвращаем
 * `hnswMismatch` для UI-warning'а; коллекцию НЕ пересоздаём (избегаем data loss).
 *
 * Returns: `{id, created, hnswMismatch}`. `created` — true если только что
 * создана, false если уже существовала. `hnswMismatch` — пустой массив если
 * config совпадает или коллекция была свежесоздана.
 */
export async function ensureChromaCollection(
  spec: ChromaCollectionSpec,
): Promise<{ id: string; created: boolean; hnswMismatch: string[] }> {
  const desiredMetadata = buildMetadata(spec);

  /* Probe — есть ли коллекция уже. Если да, проверяем расхождение HNSW. */
  let existing: ChromaCollectionResponse | null = null;
  try {
    existing = await fetchChromaJson<ChromaCollectionResponse>(
      chromaUrl(`/collections/${encodeURIComponent(spec.name)}`),
      { method: "GET", timeoutMs: 5_000 },
    );
  } catch {
    /* not found — будем создавать */
  }

  if (existing?.id) {
    setMapping(spec.name, existing.id);
    const mismatch = diffHnswMetadata(desiredMetadata, existing.metadata);
    return { id: existing.id, created: false, hnswMismatch: mismatch };
  }

  /* Создание через POST с get_or_create:true для race-safety:
     если параллельный процесс создал коллекцию между probe и нашим POST,
     мы получим существующую вместо ошибки conflict. */
  const response = await fetchChromaJson<ChromaCollectionResponse>(
    chromaUrl("/collections"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: spec.name,
        metadata: desiredMetadata,
        get_or_create: true,
      }),
      timeoutMs: 15_000,
    },
  );

  if (!response?.id) {
    throw new Error(`Chroma: create-collection "${spec.name}" returned no id`);
  }

  setMapping(spec.name, response.id);

  /* Семантика `created`:
     - `true` если probe (GET) НЕ нашёл коллекцию И POST вернул её без
       hnswMismatch → почти наверняка мы её только что создали
     - `false` если probe не нашёл, но POST вернул с другими hnsw — это
       значит race-window: между probe и POST другой процесс/инстанс
       создал коллекцию с другим config (мы её НЕ создавали)

     Chroma API не отличает «создана сейчас» от «возвращена существующая»
     в ответе POST с get_or_create — поэтому используем mismatch как
     эвристику. Для UI-warning достаточно (`hnswMismatch` всегда точный),
     `created` — best-effort hint, не строгая гарантия. */
  const mismatch = diffHnswMetadata(desiredMetadata, response.metadata);
  const wasCreatedByUs = mismatch.length === 0;
  return { id: response.id, created: wasCreatedByUs, hnswMismatch: mismatch };
}
