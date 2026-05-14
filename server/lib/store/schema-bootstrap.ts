import type { Database as DbType } from "better-sqlite3";

import {
  COLLECTION_SPECS,
  type AttributeSpec,
  type CollectionSpec,
} from "../schema-spec.js";

/**
 * Translate the shared `COLLECTION_SPECS` into SQLite DDL — one table
 * per Appwrite collection, plus the `_solo_files` metadata table the
 * storage shim needs.
 *
 * Idempotent: every statement is `IF NOT EXISTS`, so this runs safely
 * on every boot. Mirrors how `appwrite-bootstrap.ts` is idempotent
 * against a live Appwrite.
 *
 * Column model — each table carries:
 *   _id        TEXT PRIMARY KEY   → Appwrite's `$id`
 *   _createdAt TEXT               → Appwrite's `$createdAt`
 *   _updatedAt TEXT               → Appwrite's `$updatedAt`
 *   <attr>     <mapped type>      → one column per schema-spec attribute
 *
 * Attribute columns are intentionally nullable (no NOT NULL): Appwrite
 * `required` is enforced by the app layer + Zod the same way in both
 * backends, and a forgiving table avoids spurious insert failures if a
 * caller omits a field the spec calls required. `_id` is the only hard
 * constraint. Array attributes are stored as JSON text; booleans as
 * 0/1 integers — the shim handles the (de)serialisation.
 */

/** Appwrite attribute type → SQLite column affinity. */
function sqliteType(attr: AttributeSpec): string {
  if (attr.array) return "TEXT"; // JSON-encoded array
  switch (attr.type) {
    case "integer":
      return "INTEGER";
    case "double":
      return "REAL";
    case "boolean":
      return "INTEGER"; // 0 / 1
    case "string":
    case "email":
    case "enum":
    case "datetime":
      return "TEXT";
  }
}

function buildCreateTable(spec: CollectionSpec): string {
  const cols: string[] = [
    `"_id" TEXT PRIMARY KEY NOT NULL`,
    `"_createdAt" TEXT NOT NULL`,
    `"_updatedAt" TEXT NOT NULL`,
  ];
  for (const attr of spec.attributes) {
    cols.push(`"${attr.key}" ${sqliteType(attr)}`);
  }
  return `CREATE TABLE IF NOT EXISTS "${spec.id}" (\n  ${cols.join(",\n  ")}\n)`;
}

function buildCreateIndexes(spec: CollectionSpec): string[] {
  return spec.indexes.map((idx) => {
    /* SQLite index names are global, not per-table — prefix with the
     * collection id so two collections can both have a "user_state_idx". */
    const name = `${spec.id}__${idx.key}`;
    const unique = idx.type === "unique" ? "UNIQUE " : "";
    const cols = idx.attributes
      .map((col, i) => {
        const order = idx.orders?.[i];
        return order ? `"${col}" ${order}` : `"${col}"`;
      })
      .join(", ");
    /* fulltext degrades to a plain index — solo-mode `Query.search`
     * translates to a LIKE scan (see query-translate.ts). The index is
     * still created (harmless, helps equality/prefix on the same col). */
    return `CREATE ${unique}INDEX IF NOT EXISTS "${name}" ON "${spec.id}" (${cols})`;
  });
}

/** Metadata table for the filesystem-backed storage shim. */
const CREATE_SOLO_FILES = `CREATE TABLE IF NOT EXISTS "_solo_files" (
  "bucketId" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "mimeType" TEXT,
  "createdAt" TEXT NOT NULL,
  PRIMARY KEY ("bucketId", "fileId")
)`;

/**
 * Run all DDL. Called from `getStoreDb()` on first open. Wrapped in a
 * single transaction so a fresh DB is either fully bootstrapped or not
 * touched at all.
 */
export function bootstrapStoreSchema(db: DbType): void {
  const statements: string[] = [CREATE_SOLO_FILES];
  for (const spec of COLLECTION_SPECS) {
    statements.push(buildCreateTable(spec));
    statements.push(...buildCreateIndexes(spec));
  }
  const run = db.transaction(() => {
    for (const sql of statements) db.exec(sql);
  });
  run();
}
