/**
 * Arrow Schema для LanceDB-таблиц Bibliary.
 *
 * Apache Arrow — колоночный формат со СТРОГОЙ типизацией. В Chroma metadata
 * было «свободным» (одна точка имела `domain`, другая — нет). LanceDB за
 * пропуск ключа в одной row при наличии в другой валится в runtime.
 *
 * Решение: фиксированная схема со ВСЕМИ опциональными полями `nullable: true`.
 * Перед `mergeInsert` каждый row проходит canonicalizer (`canonicalizeRow`
 * в `points.ts`), который проецирует объект на полный список колонок и
 * подставляет `null` где ключа нет.
 *
 * **Эмбеддинги — 384 dim (multilingual-e5-small).** Захардкожено в схеме,
 * потому что:
 *   1. Bibliary всегда использует e5-small (см. `electron/lib/scanner/embedding.ts`).
 *   2. Менять dim requires пересоздания всех LanceDB-таблиц — миграция, а не
 *      runtime-параметр.
 *   3. LanceDB FixedSizeList требует concrete dim в schema — нельзя сделать
 *      «variable».
 *
 * **`extraJson: Utf8`** — catch-all для будущих metadata-полей. Если v2.5
 * добавит, например, `qualityScore: number`, сначала пишем JSON-stringified
 * в extraJson, потом отдельной миграцией поднимаем в собственную колонку.
 *
 * **`schemaVersion: Utf8`** — позволяет downstream'у различать legacy rows
 * без потери совместимости при добавлении новых полей.
 */

import {
  Field,
  FixedSizeList,
  Float32,
  Schema,
  Utf8,
} from "apache-arrow";

export const VECTOR_DIM = 384;
export const SCHEMA_VERSION = "1";

/**
 * Список metadata-полей которые есть «на верхнем уровне» row'а.
 * Любой ключ за пределами этого списка попадает в `extraJson`.
 *
 * Source: Chroma metadata, наблюдаемая в production:
 *   `extraction-runner.ts` upsert метаданных + `uniqueness-evaluator.ts`
 *   `chromaQueryNearest` reads.
 */
export const METADATA_FIELDS: ReadonlyArray<string> = [
  "bookId",
  "bookSourcePath",
  "domain",
  "chapterContext",
  "essence",
  "cipher",
  "proof",
  "applicability",
  "auraFlags",
  "relations",
  "tagsCsv",
  "acceptedAt",
];

/**
 * Полная Arrow Schema для concept-таблицы. Все опциональные поля
 * `nullable: true` (третий параметр Field-конструктора).
 *
 * Колонки `id`, `vector`, `document`, `schemaVersion` — required-non-null.
 * Метаданные — все nullable.
 *
 * Pagination использует нативный `.offset(n).limit(m)` LanceDB Query API
 * (`scroll.ts`). Synthetic cursor_id не понадобился — Plan B из roadmap
 * откатился после verification offset-path работает на 50K+ rows.
 */
export function buildConceptSchema(): Schema {
  return new Schema([
    new Field("id", new Utf8(), /* nullable */ false),
    new Field(
      "vector",
      new FixedSizeList(VECTOR_DIM, new Field("item", new Float32(), /* nullable */ true)),
      /* nullable */ false,
    ),
    new Field("document", new Utf8(), /* nullable */ false),
    new Field("schemaVersion", new Utf8(), /* nullable */ false),

    /* metadata — все nullable */
    new Field("bookId", new Utf8(), true),
    new Field("bookSourcePath", new Utf8(), true),
    new Field("domain", new Utf8(), true),
    new Field("chapterContext", new Utf8(), true),
    new Field("essence", new Utf8(), true),
    new Field("cipher", new Utf8(), true),
    new Field("proof", new Utf8(), true),
    new Field("applicability", new Utf8(), true),
    /* auraFlags — JSON-stringified array, чтобы не плодить колоночный type */
    new Field("auraFlags", new Utf8(), true),
    /* relations — JSON-stringified S→P→O array */
    new Field("relations", new Utf8(), true),
    /* tagsCsv — pipe-delimited "|tag1|tag2|" (наследие Chroma sanitizer'а) */
    new Field("tagsCsv", new Utf8(), true),
    new Field("acceptedAt", new Utf8(), true),

    /* catch-all для всего, чего нет в первичных колонках. Booleans
     * (isFictionOrWater) и future-fields сюда. Хранится как JSON-string
     * вместо нативной колонки, потому что Lance требует ≥1 byte bitmap
     * для bool-колонок, а all-null batch'и (типичный случай при ingest'е
     * non-fiction корпуса) валятся в writer'е. */
    new Field("extraJson", new Utf8(), true),
  ]);
}
