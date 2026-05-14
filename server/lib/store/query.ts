/**
 * Vendored drop-in replacements for the node-appwrite client helpers the
 * server used to import from `"node-appwrite"`: `Query`, `ID`,
 * `Permission`, `Role`.
 *
 * `Query` is the one that matters — it builds the JSON envelope that
 * `query-translate.ts` parses back into SQL. The two files are a
 * matched pair: every method here has a `case` there. Envelope shape:
 *   {"method":"equal","attribute":"userId","values":["abc"]}
 *
 * `Permission` / `Role` are faithful-format stubs. The document store is
 * single-tenant and ignores the permission array entirely (see
 * `document-store.ts` — the `_permissions` arg is unused and
 * `$permissions` decodes to `[]`). They exist only so the call sites
 * that pass `[Permission.read(Role.user(id)), …]` keep compiling
 * unchanged — zero behaviour change, just no node-appwrite import.
 */

import { randomBytes } from "node:crypto";

type QueryScalar = string | number | boolean;

/**
 * Build one query envelope. `attribute` / `values` are omitted when
 * absent so the JSON matches what node-appwrite emitted — and, more to
 * the point, what `query-translate.ts` reads back (`q.values ?? []`).
 */
function envelope(method: string, attribute?: string, values?: unknown[]): string {
  const obj: { method: string; attribute?: string; values?: unknown[] } = { method };
  if (attribute !== undefined) obj.attribute = attribute;
  if (values !== undefined) obj.values = values;
  return JSON.stringify(obj);
}

export const Query = {
  /** Scalar → `=`; array → `IN (…)` (the $in filter — used for status[] / rowIds[]). */
  equal: (attribute: string, value: QueryScalar | QueryScalar[]): string =>
    envelope("equal", attribute, Array.isArray(value) ? value : [value]),
  notEqual: (attribute: string, value: QueryScalar): string =>
    envelope("notEqual", attribute, [value]),
  greaterThan: (attribute: string, value: QueryScalar): string =>
    envelope("greaterThan", attribute, [value]),
  greaterThanEqual: (attribute: string, value: QueryScalar): string =>
    envelope("greaterThanEqual", attribute, [value]),
  lessThan: (attribute: string, value: QueryScalar): string =>
    envelope("lessThan", attribute, [value]),
  lessThanEqual: (attribute: string, value: QueryScalar): string =>
    envelope("lessThanEqual", attribute, [value]),
  isNull: (attribute: string): string => envelope("isNull", attribute),
  isNotNull: (attribute: string): string => envelope("isNotNull", attribute),
  search: (attribute: string, value: string): string =>
    envelope("search", attribute, [value]),
  orderAsc: (attribute: string): string => envelope("orderAsc", attribute),
  orderDesc: (attribute: string): string => envelope("orderDesc", attribute),
  limit: (limit: number): string => envelope("limit", undefined, [limit]),
  offset: (offset: number): string => envelope("offset", undefined, [offset]),
  select: (attributes: string[]): string => envelope("select", undefined, attributes),
};

/**
 * Document / file id generator. node-appwrite's `ID.unique()` produced a
 * ~20-char hex-ish string; this matches that contract — timestamp +
 * 72 random bits, all `[0-9a-f]`, ≤36 chars. The file store still
 * validates ids as path segments, so staying within `[A-Za-z0-9_-]`
 * matters.
 */
export const ID = {
  unique: (): string => Date.now().toString(16) + randomBytes(9).toString("hex"),
};

/** Permission target — `Role.user("abc")` → `"user:abc"`. */
export const Role = {
  user: (id: string, status?: string): string =>
    status ? `user:${id}/${status}` : `user:${id}`,
  users: (status?: string): string => (status ? `users/${status}` : "users"),
  team: (id: string, role?: string): string =>
    role ? `team:${id}/${role}` : `team:${id}`,
};

/** Permission grant — `Permission.read(Role.user("abc"))` → `read("user:abc")`. */
export const Permission = {
  read: (role: string): string => `read("${role}")`,
  create: (role: string): string => `create("${role}")`,
  update: (role: string): string => `update("${role}")`,
  delete: (role: string): string => `delete("${role}")`,
};
