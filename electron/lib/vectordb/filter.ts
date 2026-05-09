/**
 * Translator: Chroma-style metadata filter → LanceDB SQL predicate string.
 *
 * Chroma использовал JSON-объект:
 *   `{ bookId: "abc" }`                                  → exact match
 *   `{ bookId: { $eq: "abc" } }`                         → explicit eq
 *   `{ $and: [{ bookId: "x" }, { domain: "math" }] }`    → AND
 *   `{ $or:  [{ bookId: "x" }, { bookId: "y" }] }`       → OR
 *   `{ field: { $in: [a, b] } }`                         → IN
 *
 * LanceDB ожидает SQL-предикат (DataFusion):
 *   `bookId = 'abc'`
 *   `bookId = 'abc' AND domain = 'math'`
 *   `bookId = 'x' OR bookId = 'y'`
 *   `field IN ('a', 'b')`
 *
 * Безопасность:
 *   - Field names валидируются `/^[A-Za-z_][A-Za-z0-9_]*$/` (whitelist).
 *   - String values escape'аются по SQL правилу `'` → `''`.
 *   - Numbers / bool вставляются inline без кавычек (DataFusion парсит).
 *   - Любой неизвестный оператор / неподдерживаемая структура → throw,
 *     не silent-skip — иначе можно получить «удалили не то».
 */

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SUPPORTED_OPERATORS = new Set([
  "$and", "$or", "$eq", "$ne", "$in", "$nin", "$gt", "$gte", "$lt", "$lte",
]);

/** Empty where → `null` (caller трактует как «без фильтра»). */
export function chromaWhereToLance(where: Record<string, unknown> | null | undefined): string | null {
  if (!where || Object.keys(where).length === 0) return null;
  const sql = compileObject(where);
  return sql.length > 0 ? sql : null;
}

function compileObject(obj: Record<string, unknown>): string {
  /* Top-level — `{$and: [...], $or: [...], field: ...}`. Может быть
   * несколько ключей одновременно — Chroma трактует их как `$and`. */
  const keys = Object.keys(obj);
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(compileKeyValue(key, obj[key]));
  }
  if (parts.length === 1) return parts[0];
  return `(${parts.join(" AND ")})`;
}

function compileKeyValue(key: string, value: unknown): string {
  if (key === "$and" || key === "$or") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`[vectordb-filter] ${key} expects non-empty array`);
    }
    const joiner = key === "$and" ? " AND " : " OR ";
    const inner = value.map((v) => {
      if (!isPlainObject(v)) {
        throw new Error(`[vectordb-filter] ${key} elements must be objects`);
      }
      return compileObject(v as Record<string, unknown>);
    });
    return `(${inner.join(joiner)})`;
  }

  if (key.startsWith("$")) {
    throw new Error(`[vectordb-filter] unexpected top-level operator "${key}"`);
  }

  if (!FIELD_NAME_RE.test(key)) {
    throw new Error(`[vectordb-filter] invalid field name "${key}" (whitelist /^[A-Za-z_][A-Za-z0-9_]*$/)`);
  }

  /* `{field: scalar}` — shorthand for $eq */
  if (isScalar(value)) {
    return `${quoteIdent(key)} = ${literal(value)}`;
  }

  /* `{field: {$op: ...}}` */
  if (isPlainObject(value)) {
    return compileFieldOps(key, value as Record<string, unknown>);
  }

  if (Array.isArray(value)) {
    throw new Error(`[vectordb-filter] field "${key}" must use {$in: [...]} for arrays`);
  }

  throw new Error(`[vectordb-filter] unsupported value for field "${key}": ${typeof value}`);
}

function compileFieldOps(field: string, ops: Record<string, unknown>): string {
  const opKeys = Object.keys(ops);
  if (opKeys.length === 0) {
    throw new Error(`[vectordb-filter] field "${field}": empty operator object`);
  }
  const parts: string[] = [];
  for (const op of opKeys) {
    if (!SUPPORTED_OPERATORS.has(op)) {
      throw new Error(`[vectordb-filter] field "${field}": unsupported operator "${op}"`);
    }
    const v = ops[op];
    const ident = quoteIdent(field);
    switch (op) {
      case "$eq":
        if (!isScalar(v)) throw new Error(`[vectordb-filter] $eq expects scalar`);
        parts.push(`${ident} = ${literal(v)}`);
        break;
      case "$ne":
        if (!isScalar(v)) throw new Error(`[vectordb-filter] $ne expects scalar`);
        parts.push(`${ident} != ${literal(v)}`);
        break;
      case "$gt":
        if (!isScalar(v)) throw new Error(`[vectordb-filter] $gt expects scalar`);
        parts.push(`${ident} > ${literal(v)}`);
        break;
      case "$gte":
        if (!isScalar(v)) throw new Error(`[vectordb-filter] $gte expects scalar`);
        parts.push(`${ident} >= ${literal(v)}`);
        break;
      case "$lt":
        if (!isScalar(v)) throw new Error(`[vectordb-filter] $lt expects scalar`);
        parts.push(`${ident} < ${literal(v)}`);
        break;
      case "$lte":
        if (!isScalar(v)) throw new Error(`[vectordb-filter] $lte expects scalar`);
        parts.push(`${ident} <= ${literal(v)}`);
        break;
      case "$in": {
        if (!Array.isArray(v) || v.length === 0) {
          throw new Error(`[vectordb-filter] $in expects non-empty array`);
        }
        const lits = v.map((x) => {
          if (!isScalar(x)) throw new Error(`[vectordb-filter] $in array values must be scalar`);
          return literal(x);
        });
        parts.push(`${ident} IN (${lits.join(", ")})`);
        break;
      }
      case "$nin": {
        if (!Array.isArray(v) || v.length === 0) {
          throw new Error(`[vectordb-filter] $nin expects non-empty array`);
        }
        const lits = v.map((x) => {
          if (!isScalar(x)) throw new Error(`[vectordb-filter] $nin array values must be scalar`);
          return literal(x);
        });
        parts.push(`${ident} NOT IN (${lits.join(", ")})`);
        break;
      }
      /* $and / $or на уровне field не имеет смысла — handled выше */
      default:
        throw new Error(`[vectordb-filter] unsupported operator "${op}"`);
    }
  }
  if (parts.length === 1) return parts[0];
  return `(${parts.join(" AND ")})`;
}

function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * DataFusion SQL parser, used by LanceDB, по умолчанию lowercase'ит
 * unquoted identifiers (`bookId` → `bookid`) → schema error.
 * Стандартный ANSI SQL предлагает `"..."` для case-sensitive identifier'ов,
 * но эта конкретная конфигурация DataFusion трактует `"..."` как string
 * literal, и `"bookId" = 'b1'` сравнивает строку 'bookId' со 'b1' (false).
 * Backticks работают как identifier-quote во всех протестированных
 * DataFusion-сценариях. Field name прошёл whitelist-валидацию в caller'е,
 * injection через quoting не проходит.
 */
function quoteIdent(name: string): string {
  return `\`${name}\``;
}

function literal(v: string | number | boolean): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`[vectordb-filter] non-finite number: ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  /* SQL escape для одинарных кавычек: 'O''Brien'. */
  return `'${v.replace(/'/g, "''")}'`;
}

/* ─── Public helpers — backward compat с chroma/points.ts API ──────── */

/** `whereExact("bookId", "abc")` → `{bookId: "abc"}` (idiomatic Chroma form). */
export function whereExact(field: string, value: string | number | boolean): Record<string, unknown> {
  return { [field]: value };
}

/** OR через `$or`. Один matcher → degraded в простой equality. */
export function whereAnyOf(
  matchers: Array<{ field: string; value: string | number | boolean }>,
): Record<string, unknown> {
  if (matchers.length === 0) return {};
  if (matchers.length === 1) return { [matchers[0].field]: matchers[0].value };
  return { $or: matchers.map((m) => ({ [m.field]: m.value })) };
}

/** AND через `$and`. */
export function whereAllOf(
  matchers: Array<{ field: string; value: string | number | boolean }>,
): Record<string, unknown> {
  if (matchers.length === 0) return {};
  if (matchers.length === 1) return { [matchers[0].field]: matchers[0].value };
  return { $and: matchers.map((m) => ({ [m.field]: m.value })) };
}
