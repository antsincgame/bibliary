import type { Config } from "../../config.js";
import type { DatastoreHandles } from "../datastore.js";
import { getStoreDb } from "./db.js";
import { DocumentStore } from "./document-store.js";
import { FileStore } from "./file-store.js";

/**
 * Build the solo-mode `DatastoreHandles` — a SQLite-backed `databases`
 * and a filesystem-backed `storage`, both sharing the one `bibliary.db`
 * connection. `client` and `users` are omitted: solo mode has no
 * Appwrite client, and the `Users` service was never used by the
 * server anyway.
 *
 * Kept in its own module (not inlined into `appwrite.ts`) so the
 * import graph stays acyclic: `appwrite.ts` value-imports this factory,
 * this factory value-imports the shims, and the shims only ever
 * type-import back from `appwrite.ts` — erased at runtime.
 */
export function createStoreHandles(cfg: Config): DatastoreHandles {
  const { db } = getStoreDb(cfg);
  return {
    databases: new DocumentStore(db),
    storage: new FileStore(db, cfg),
    databaseId: cfg.APPWRITE_DATABASE_ID,
  };
}
