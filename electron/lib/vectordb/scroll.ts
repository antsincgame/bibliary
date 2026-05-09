/**
 * Async-generator pagination через LanceDB-таблицу.
 *
 * Заменяет `electron/lib/chroma/scroll.ts` — yield shape (`VectorPage`)
 * максимально близок к старому `ChromaPage` чтобы `concept-loader.ts` и
 * другие потребители получили механический drop-in.
 *
 * **Pagination strategy** (из плана, Section A):
 *   - **Plan A — нативный `.offset(n).limit(m)`**: LanceDB Query поддерживает
 *     offset через DataFusion. Это primary path.
 *   - **Plan B — synthetic cursor**: `id`-сортировка lex-небезопасна
 *     (Chroma могла писать UUIDv4 / SHA-256). Если в Phase 3 миграции пойдём
 *     по этому пути, добавим колонку `cursor_id: Int32` (уже в schema) и
 *     перейдём на `where("cursor_id > $last")`. Сейчас Plan A.
 *
 * Каждая страница возвращает плоский массив rows c поднятой metadata
 * (через `extractMetadataFromRow`) — caller получает то же самое что
 * `chromaQueryNearest`/scroll отдавал раньше.
 */

import { openTable } from "./store.js";
import { chromaWhereToLance } from "./filter.js";
import { METADATA_FIELDS } from "./schema.js";

export type VectorInclude = "documents" | "metadatas" | "embeddings";

export interface ScrollVectorsOptions {
  /** Имя таблицы. */
  tableName: string;
  /** Optional Chroma-style metadata filter. */
  where?: Record<string, unknown>;
  /** Какие поля включить в каждую row. По умолчанию `["metadatas"]`. */
  include?: VectorInclude[];
  /** Размер страницы. По умолчанию 256 (как было в Chroma). */
  pageSize?: number;
  /** Hard cap на общее число rows (защита от runaway). По умолчанию 50_000. */
  maxItems?: number;
  /** AbortSignal для cooperative cancellation. */
  signal?: AbortSignal;
}

/** То же поле-тело что и `ChromaPage` — каждый поле опциональное по include. */
export interface VectorPage {
  ids: string[];
  documents?: (string | null)[];
  metadatas?: (Record<string, unknown> | null)[];
  embeddings?: (number[] | null)[];
}

const DEFAULT_PAGE_SIZE = 256;
const DEFAULT_MAX_ITEMS = 50_000;

/**
 * Async generator: yield по странице. Завершается на первой пустой
 * странице или при достижении maxItems. На abort бросает `Error("aborted")`.
 *
 * Внутри использует LanceDB query API:
 *   table.query().select(columns).where(predicate).offset(offset).limit(pageSize).toArray()
 *
 * Если в установленной версии SDK нет .offset() — увидите ошибку при
 * первом вызове и упадёте раньше unit-тестами в Phase 1, что и нужно.
 * В этом случае правка — переход на cursor_id (см. plan).
 */
export async function* scrollVectors(opts: ScrollVectorsOptions): AsyncGenerator<VectorPage, void, void> {
  const include = opts.include ?? ["metadatas"];
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, 10_000));
  const maxItems = Math.max(1, opts.maxItems ?? DEFAULT_MAX_ITEMS);

  const table = await openTable(opts.tableName);
  const predicate = opts.where ? chromaWhereToLance(opts.where) : null;

  /* Колонки для select() — Lance может отдать всю row, мы это разруливаем
   * в проекции. Для include=["metadatas"] нам не нужны embeddings (тяжёлые),
   * для include=["embeddings"] — наоборот. */
  const wantDocs = include.includes("documents");
  const wantMetas = include.includes("metadatas");
  const wantEmbs = include.includes("embeddings");

  const selectColumns: string[] = ["id"];
  if (wantDocs) selectColumns.push("document");
  if (wantEmbs) selectColumns.push("vector");
  if (wantMetas) {
    selectColumns.push(...METADATA_FIELDS, "extraJson");
  }

  let offset = 0;
  let yielded = 0;

  /* CONCURRENCY caveat: LanceDB Query API не имеет `orderBy` (verified
   * через `node_modules/@lancedb/lancedb/dist/query.d.ts:165-199` — только
   * select/where/limit/offset). Default order — implementation-defined
   * (insertion order). Если concurrent writer добавит row между нашими
   * страницами в самое начало (фактически невозможно — Lance append-only,
   * но теоретически), offset N+pageSize может skip/duplicate. Bibliary
   * mitigation:
   *   1. `vectorUpsert` идёт под per-table `KeyedAsyncMutex` — concurrent
   *      writes на ту же таблицу сериализуются, нет race window'ов между
   *      delete и add.
   *   2. Caller (concept-loader / dataset-v2) использует scroll только в
   *      read-only фазах (domain breakdown), без параллельного re-extract'а.
   * Если в будущем потребуется stable pagination под concurrent writes —
   * перейти на cursor-based: `where("id > 'last_id'")`, sort полагаясь на
   * лексикографический порядок UUIDv7 / ULID id'ов. */
  while (yielded < maxItems) {
    if (opts.signal?.aborted) throw new Error("scrollVectors: aborted");

    const limit = Math.min(pageSize, maxItems - yielded);

    let q = table.query().select(selectColumns).limit(limit).offset(offset);
    if (predicate) q = q.where(predicate);

    const rows = (await q.toArray()) as Array<Record<string, unknown>>;
    const count = rows.length;
    if (count === 0) return;

    const page: VectorPage = { ids: rows.map((r) => String(r.id ?? "")) };
    if (wantDocs) {
      page.documents = rows.map((r) => (typeof r.document === "string" ? r.document : null));
    }
    if (wantMetas) {
      page.metadatas = rows.map(extractMetadataFromRow);
    }
    if (wantEmbs) {
      page.embeddings = rows.map((r) => extractEmbedding(r.vector));
    }

    yield page;
    yielded += count;
    offset += count;

    if (count < limit) return; /* короткая страница = последняя */
  }
}

/**
 * Удобная обёртка: накопить ВСЕ pages в один массив metadata-объектов.
 * Совместимо с `collectAllMetadatas` из chroma-эры.
 */
export async function collectAllMetadatas(
  opts: ScrollVectorsOptions,
): Promise<Array<Record<string, unknown> | null>> {
  const acc: Array<Record<string, unknown> | null> = [];
  for await (const page of scrollVectors({ ...opts, include: ["metadatas"] })) {
    for (const m of page.metadatas ?? []) acc.push(m);
  }
  return acc;
}

/* ─── helpers (also used by points.ts) ─────────────────────────────── */

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
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * Lance отдаёт vector-колонку либо как Float32Array, либо как обычный
 * массив, либо как Arrow Vector — нормализуем к number[].
 */
function extractEmbedding(v: unknown): number[] | null {
  if (v == null) return null;
  if (v instanceof Float32Array) return Array.from(v);
  if (Array.isArray(v)) return v.map((x) => Number(x));
  /* Arrow Vector — has .toArray() */
  if (typeof (v as { toArray?: () => unknown }).toArray === "function") {
    const arr = (v as { toArray: () => unknown }).toArray();
    if (arr instanceof Float32Array) return Array.from(arr);
    if (Array.isArray(arr)) return arr.map((x) => Number(x));
  }
  return null;
}
