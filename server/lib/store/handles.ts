import type { Config } from "../../config.js";
import type { DatastoreHandles } from "../datastore.js";
import { getStoreDb } from "./db.js";
import { DocumentStore } from "./document-store.js";
import { FileStore } from "./file-store.js";

/**
 * Build the `DatastoreHandles` — a SQLite-backed `databases` and a
 * filesystem-backed `storage`, both sharing the one `bibliary.db`
 * connection.
 *
 * Kept in its own module (not inlined into `datastore.ts`) so the
 * import graph stays acyclic: `datastore.ts` value-imports this
 * factory, this factory value-imports the stores, and the stores only
 * ever type-import back from `datastore.ts` — erased at runtime.
 */
export function createStoreHandles(cfg: Config): DatastoreHandles {
  const { db } = getStoreDb(cfg);
  return {
    databases: new DocumentStore(db),
    storage: new FileStore(db, cfg),
    /* The store ignores `databaseId` (it lands as the unused
     * `_databaseId` arg in every method) — a fixed label keeps the
     * handle shape stable for the callers that still pass it through. */
    databaseId: "bibliary",
  };
}
