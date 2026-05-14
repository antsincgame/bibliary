/**
 * Translate node-appwrite `Query.*` strings into SQL fragments for the
 * solo-mode SQLite shim.
 *
 * Every `Query.equal(...)` / `Query.limit(...)` / etc. call in the
 * codebase produces a JSON string of the shape
 *   {"method":"equal","attribute":"userId","values":["abc"]}
 * (`values` is always an array — node-appwrite wraps scalars; for
 * `limit`/`offset`/`orderAsc` some of `attribute`/`values` are absent).
 * The repo files pass `string[]` of these to `databases.listDocuments`.
 * This module parses them back into a WHERE clause + params + ORDER BY
 * + LIMIT/OFFSET + SELECT.
 *
 * SECURITY: an unrecognised *filter* method must throw, never be
 * silently dropped — a dropped `Query.equal("userId", ...)` would leak
 * every user's rows. We throw on ANY unknown method so the failure is
 * loud at the call site, not a silent data exposure.
 */

export type SqlParam = string | number | bigint | Buffer | null;

export interface TranslatedQuery {
  /** SQL boolean expression WITHOUT the leading "WHERE" (empty string = no filter). */
  where: string;
  params: SqlParam[];
  /** SQL ORDER BY clause WITHOUT the leading "ORDER BY" (empty string = unordered). */
  orderBy: string;
  /** null = no limit requested. */
  limit: number | null;
  offset: number;
  /** Attribute keys requested via Query.select, or null for "all columns". */
  select: string[] | null;
}

interface RawQuery {
  method: string;
  attribute?: string;
  values?: unknown[];
}

/** Appwrite meta fields map to the shim's underscore-prefixed columns. */
function columnFor(attribute: string): string {
  if (attribute === "$id") return "_id";
  if (attribute === "$createdAt") return "_createdAt";
  if (attribute === "$updatedAt") return "_updatedAt";
  return attribute;
}

/** better-sqlite3 rejects JS booleans as bind params — coerce to 0/1. */
function toSqlParam(v: unknown): SqlParam {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v;
  /* Objects/arrays should never reach a single-value bind slot. */
  return String(v);
}

export function translateQueries(queries: string[] = []): TranslatedQuery {
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  const orderParts: string[] = [];
  let limit: number | null = null;
  let offset = 0;
  let select: string[] | null = null;

  for (const raw of queries) {
    let q: RawQuery;
    try {
      q = JSON.parse(raw) as RawQuery;
    } catch {
      throw new Error(`[solo-query] malformed query string: ${raw}`);
    }
    const attr = q.attribute;
    const col = attr ? `"${columnFor(attr)}"` : "";
    const values = q.values ?? [];

    switch (q.method) {
      case "equal": {
        /* values is always an array; 1 → "=", many → "IN". Appwrite
         * treats Query.equal(attr, [a,b]) as an $in filter — repo.ts
         * uses this for status[] and routes/datasets.ts for rowIds[]. */
        if (values.length === 0) {
          throw new Error(`[solo-query] equal on "${attr}" with no values`);
        }
        if (values.length === 1) {
          conditions.push(`${col} = ?`);
          params.push(toSqlParam(values[0]));
        } else {
          conditions.push(`${col} IN (${values.map(() => "?").join(", ")})`);
          for (const v of values) params.push(toSqlParam(v));
        }
        break;
      }
      case "notEqual":
        conditions.push(`${col} != ?`);
        params.push(toSqlParam(values[0]));
        break;
      case "greaterThan":
        conditions.push(`${col} > ?`);
        params.push(toSqlParam(values[0]));
        break;
      case "greaterThanEqual":
        conditions.push(`${col} >= ?`);
        params.push(toSqlParam(values[0]));
        break;
      case "lessThan":
        conditions.push(`${col} < ?`);
        params.push(toSqlParam(values[0]));
        break;
      case "lessThanEqual":
        conditions.push(`${col} <= ?`);
        params.push(toSqlParam(values[0]));
        break;
      case "isNull":
        conditions.push(`${col} IS NULL`);
        break;
      case "isNotNull":
        conditions.push(`${col} IS NOT NULL`);
        break;
      case "search": {
        /* Appwrite fulltext → substring LIKE. Case-insensitive for
         * ASCII via SQLite's default NOCASE-ish LIKE; good enough for
         * the one call site (book title search). Escape LIKE
         * metacharacters in the user term so "%"/"_" are literal. */
        const term = String(values[0] ?? "");
        const escaped = term.replace(/[\\%_]/g, (m) => `\\${m}`);
        conditions.push(`${col} LIKE ? ESCAPE '\\'`);
        params.push(`%${escaped}%`);
        break;
      }
      case "orderAsc":
        orderParts.push(`${col} ASC`);
        break;
      case "orderDesc":
        orderParts.push(`${col} DESC`);
        break;
      case "limit": {
        const n = Number(values[0]);
        if (Number.isFinite(n)) limit = n;
        break;
      }
      case "offset": {
        const n = Number(values[0]);
        if (Number.isFinite(n)) offset = n;
        break;
      }
      case "select":
        select = values.map((v) => String(v));
        break;
      default:
        /* Unknown method — throw rather than drop. A dropped filter is
         * a cross-user data leak; a dropped ordering/pagination is just
         * wrong results. Either way the caller must know. */
        throw new Error(
          `[solo-query] unsupported Query method "${q.method}" — ` +
            `add it to query-translate.ts before using it in solo mode`,
        );
    }
  }

  return {
    where: conditions.join(" AND "),
    params,
    orderBy: orderParts.join(", "),
    limit,
    offset,
    select,
  };
}
