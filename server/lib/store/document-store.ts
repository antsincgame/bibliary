import type { Database as DbType } from "better-sqlite3";

import type { DatabasesLike, RawDoc } from "../datastore.js";
import {
  COLLECTION_SPECS,
  type AttributeSpec,
  type CollectionSpec,
} from "../schema-spec.js";
import { translateQueries, type SqlParam } from "./query-translate.js";

/**
 * Solo-mode `Databases` shim — implements the slice of the node-appwrite
 * `Databases` API that the Bibliary server actually calls
 * (`createDocument`, `getDocument`, `updateDocument`, `deleteDocument`,
 * `listDocuments`). Backed by the plain SQLite tables that
 * `solo-bootstrap.ts` creates.
 *
 * Contract fidelity is the whole point: every repo file
 * (`job-store.ts`, `library/repository.ts`, …) keeps calling
 * `databases.createDocument(...)` exactly as before — they cannot tell
 * they're talking to SQLite instead of Appwrite. That's why the
 * methods are `async` even though better-sqlite3 is synchronous, and
 * why reads reconstruct the `$id / $createdAt / $updatedAt /
 * $collectionId / $databaseId / $permissions` envelope.
 *
 * Storage model — see solo-bootstrap.ts: `_id/_createdAt/_updatedAt`
 * meta columns + one column per attribute. Array attributes are JSON
 * text, booleans are 0/1 — this module owns that (de)serialisation.
 */

const SOLO_DATABASE_ID = "bibliary";

interface CollectionMeta {
  spec: CollectionSpec;
  attrKeys: string[];
  byKey: Map<string, AttributeSpec>;
  arrayKeys: Set<string>;
  boolKeys: Set<string>;
}

function buildCollectionMeta(): Map<string, CollectionMeta> {
  const map = new Map<string, CollectionMeta>();
  for (const spec of COLLECTION_SPECS) {
    const byKey = new Map<string, AttributeSpec>();
    const arrayKeys = new Set<string>();
    const boolKeys = new Set<string>();
    for (const attr of spec.attributes) {
      byKey.set(attr.key, attr);
      if (attr.array) arrayKeys.add(attr.key);
      if (attr.type === "boolean" && !attr.array) boolKeys.add(attr.key);
    }
    map.set(spec.id, {
      spec,
      attrKeys: spec.attributes.map((a) => a.key),
      byKey,
      arrayKeys,
      boolKeys,
    });
  }
  return map;
}

/** Appwrite-shaped 404 so callers' `isStoreErrorCode(err, 404)` keeps working. */
function notFound(collectionId: string, documentId: string): Error & { code: number } {
  const err = new Error(
    `Document with the requested ID could not be found (${collectionId}/${documentId}).`,
  ) as Error & { code: number; type: string };
  err.code = 404;
  err.type = "document_not_found";
  return err;
}

type Row = Record<string, unknown>;

export class DocumentStore implements DatabasesLike {
  private readonly meta = buildCollectionMeta();

  constructor(private readonly db: DbType) {}

  private metaFor(collectionId: string): CollectionMeta {
    const m = this.meta.get(collectionId);
    if (!m) {
      throw new Error(
        `[solo-store] unknown collection "${collectionId}" — not in schema-spec.ts`,
      );
    }
    return m;
  }

  /**
   * Connectivity probe used by /health and /system. A no-op SELECT 1
   * confirms the SQLite handle is open and responsive — the solo-mode
   * equivalent of "the database is reachable".
   */
  async get(_databaseId: string): Promise<{ $id: string; name: string }> {
    this.db.prepare("SELECT 1").get();
    return { $id: SOLO_DATABASE_ID, name: "Bibliary (solo / SQLite)" };
  }

  /** Encode one attribute value for storage (array → JSON, bool → 0/1). */
  private encode(meta: CollectionMeta, key: string, value: unknown): SqlParam {
    if (value === undefined || value === null) return null;
    if (meta.arrayKeys.has(key)) return JSON.stringify(value);
    if (meta.boolKeys.has(key)) return value ? 1 : 0;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
      return value;
    }
    if (Buffer.isBuffer(value)) return value;
    /* Anything else (nested object) — store as JSON so it round-trips. */
    return JSON.stringify(value);
  }

  /** Rebuild an Appwrite-shaped document from a raw SQLite row. */
  private decode(
    meta: CollectionMeta,
    row: Row,
    select: string[] | null,
  ): RawDoc & Record<string, unknown> {
    const doc: Record<string, unknown> = {
      $id: row["_id"] as string,
      $collectionId: meta.spec.id,
      $databaseId: SOLO_DATABASE_ID,
      $createdAt: row["_createdAt"] as string,
      $updatedAt: row["_updatedAt"] as string,
      /* Solo mode is single-user; ownership is enforced in app code
       * (the `if (raw.userId !== userId)` checks), so the permission
       * array is intentionally empty — nothing reads it. */
      $permissions: [],
    };
    const keys = select ? meta.attrKeys.filter((k) => select.includes(k)) : meta.attrKeys;
    for (const key of keys) {
      const raw = row[key];
      if (meta.arrayKeys.has(key)) {
        doc[key] = raw == null ? [] : (JSON.parse(String(raw)) as unknown);
      } else if (meta.boolKeys.has(key)) {
        doc[key] = raw == null ? null : raw === 1 || raw === true;
      } else {
        doc[key] = raw ?? null;
      }
    }
    return doc as RawDoc & Record<string, unknown>;
  }

  async createDocument<T extends object = Record<string, unknown>>(
    _databaseId: string,
    collectionId: string,
    documentId: string,
    data: Record<string, unknown>,
    _permissions?: string[],
  ): Promise<T & RawDoc> {
    const meta = this.metaFor(collectionId);
    const now = new Date().toISOString();

    const cols = ["_id", "_createdAt", "_updatedAt"];
    const params: SqlParam[] = [documentId, now, now];
    for (const key of meta.attrKeys) {
      cols.push(key);
      /* Missing attr → apply the schema-spec default if there is one,
       * else null. Mirrors Appwrite stamping defaults server-side. */
      let value = data[key];
      if (value === undefined) {
        const spec = meta.byKey.get(key);
        value = spec && spec.default !== undefined ? spec.default : undefined;
      }
      params.push(this.encode(meta, key, value));
    }
    const placeholders = cols.map(() => "?").join(", ");
    const quotedCols = cols.map((c) => `"${c}"`).join(", ");
    try {
      this.db
        .prepare(`INSERT INTO "${collectionId}" (${quotedCols}) VALUES (${placeholders})`)
        .run(...params);
    } catch (err) {
      /* SQLite UNIQUE constraint → Appwrite-shaped 409 so callers that
       * branch on isStoreErrorCode(err, 409) (dedup paths) keep working. */
      if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) {
        const conflict = new Error(
          `Document already exists (${collectionId}/${documentId}): ${err.message}`,
        ) as Error & { code: number; type: string };
        conflict.code = 409;
        conflict.type = "document_already_exists";
        throw conflict;
      }
      throw err;
    }
    return this.getDocument<T>(_databaseId, collectionId, documentId);
  }

  async getDocument<T extends object = Record<string, unknown>>(
    _databaseId: string,
    collectionId: string,
    documentId: string,
    _queries?: string[],
  ): Promise<T & RawDoc> {
    const meta = this.metaFor(collectionId);
    const row = this.db
      .prepare(`SELECT * FROM "${collectionId}" WHERE "_id" = ?`)
      .get(documentId) as Row | undefined;
    if (!row) throw notFound(collectionId, documentId);
    return this.decode(meta, row, null) as T & RawDoc;
  }

  async updateDocument<T extends object = Record<string, unknown>>(
    _databaseId: string,
    collectionId: string,
    documentId: string,
    data?: Record<string, unknown>,
    _permissions?: string[],
  ): Promise<T & RawDoc> {
    const meta = this.metaFor(collectionId);
    const patch = data ?? {};

    const sets = [`"_updatedAt" = ?`];
    const params: SqlParam[] = [new Date().toISOString()];
    for (const key of meta.attrKeys) {
      if (!(key in patch)) continue; // partial update — only provided keys
      sets.push(`"${key}" = ?`);
      params.push(this.encode(meta, key, patch[key]));
    }
    params.push(documentId);

    const res = this.db
      .prepare(`UPDATE "${collectionId}" SET ${sets.join(", ")} WHERE "_id" = ?`)
      .run(...params);
    if (res.changes === 0) throw notFound(collectionId, documentId);
    return this.getDocument<T>(_databaseId, collectionId, documentId);
  }

  async deleteDocument(
    _databaseId: string,
    collectionId: string,
    documentId: string,
  ): Promise<Record<string, never>> {
    this.metaFor(collectionId); // validate collection
    const res = this.db
      .prepare(`DELETE FROM "${collectionId}" WHERE "_id" = ?`)
      .run(documentId);
    if (res.changes === 0) throw notFound(collectionId, documentId);
    return {};
  }

  async listDocuments<T extends object = Record<string, unknown>>(
    _databaseId: string,
    collectionId: string,
    queries: string[] = [],
  ): Promise<{ total: number; documents: Array<T & RawDoc> }> {
    const meta = this.metaFor(collectionId);
    const { where, params, orderBy, limit, offset, select } = translateQueries(queries);

    const whereSql = where ? ` WHERE ${where}` : "";

    /* `total` is the full match count ignoring limit/offset — that's
     * the Appwrite contract, and listUserJobs/listExports rely on it
     * for pagination UI. */
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM "${collectionId}"${whereSql}`)
      .get(...params) as { n: number };

    let sql = `SELECT * FROM "${collectionId}"${whereSql}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    const rowParams = [...params];
    if (limit !== null) {
      sql += ` LIMIT ?`;
      rowParams.push(limit);
      if (offset > 0) {
        sql += ` OFFSET ?`;
        rowParams.push(offset);
      }
    } else if (offset > 0) {
      /* SQLite needs a LIMIT before OFFSET — use the max sentinel. */
      sql += ` LIMIT -1 OFFSET ?`;
      rowParams.push(offset);
    }

    const rows = this.db.prepare(sql).all(...rowParams) as Row[];
    return {
      total: countRow.n,
      documents: rows.map((r) => this.decode(meta, r, select) as T & RawDoc),
    };
  }
}
