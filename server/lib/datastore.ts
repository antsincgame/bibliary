import { type Config, loadConfig } from "../config.js";
import { createStoreHandles } from "./store/handles.js";

/**
 * Bare meta-fields every stored document carries. Reads reconstruct this
 * envelope from the SQLite row (see `store/document-store.ts`) so the
 * rest of the server sees one stable document shape. Use as
 * `RawDoc & MyFields` so generic store methods accept our types.
 */
export interface RawDoc {
  $id: string;
  $collectionId: string;
  $databaseId: string;
  $createdAt: string;
  $updatedAt: string;
  /**
   * Always `[]` — Bibliary is single-tenant; ownership is enforced in
   * app code via `userId` checks, not a permission array.
   */
  $permissions: string[];
}

/** Metadata shape returned by the file store's `getFile` / `createFile`. */
export interface RawFileDoc {
  $id: string;
  bucketId: string;
  name: string;
  sizeOriginal: number;
  mimeType: string;
  $createdAt: string;
  $updatedAt: string;
  $permissions: string[];
  signature: string;
  chunksTotal: number;
  chunksUploaded: number;
}

/**
 * Minimal `File`-like contract for storage uploads — what `InputFile`
 * (`store/input-file.ts`) produces and what `FileStore.createFile`
 * consumes. Only these four members are touched.
 */
export interface UploadableFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The document-store surface the server calls. `DocumentStore`
 * (`store/document-store.ts`, SQLite-backed) is the implementation;
 * typing handles against this narrow interface — rather than the
 * concrete class — keeps every call site honestly typed.
 */
export interface DatabasesLike {
  /**
   * Database metadata — used by the /health and /system routes as the
   * cheapest possible connectivity probe (confirms the SQLite handle is
   * open and responsive).
   */
  get(databaseId: string): Promise<{ $id: string; name: string }>;
  createDocument<T extends object = Record<string, unknown>>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: object,
    permissions?: string[],
  ): Promise<T & RawDoc>;
  getDocument<T extends object = Record<string, unknown>>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    queries?: string[],
  ): Promise<T & RawDoc>;
  updateDocument<T extends object = Record<string, unknown>>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data?: object,
    permissions?: string[],
  ): Promise<T & RawDoc>;
  deleteDocument(
    databaseId: string,
    collectionId: string,
    documentId: string,
  ): Promise<unknown>;
  listDocuments<T extends object = Record<string, unknown>>(
    databaseId: string,
    collectionId: string,
    queries?: string[],
  ): Promise<{ total: number; documents: Array<T & RawDoc> }>;
}

/** The file-store surface the server calls (`FileStore`, filesystem-backed). */
export interface StorageLike {
  createFile(
    bucketId: string,
    fileId: string,
    file: UploadableFile,
    permissions?: string[],
  ): Promise<RawFileDoc>;
  getFile(bucketId: string, fileId: string): Promise<RawFileDoc>;
  getFileDownload(
    bucketId: string,
    fileId: string,
  ): Promise<ArrayBuffer | Buffer | Uint8Array>;
  deleteFile(bucketId: string, fileId: string): Promise<unknown>;
}

export interface DatastoreHandles {
  databases: DatabasesLike;
  storage: StorageLike;
  databaseId: string;
}

let cached: DatastoreHandles | null = null;

/**
 * Server-side data handles — a SQLite document store + a filesystem file
 * store, both sharing the one `bibliary.db` connection. ALL backend code
 * must go through this accessor; tests rely on swapping `cached` via
 * `setDatastoreForTesting`.
 */
export function getDatastore(cfg: Config = loadConfig()): DatastoreHandles {
  if (cached) return cached;
  cached = createStoreHandles(cfg);
  return cached;
}

export function setDatastoreForTesting(handles: DatastoreHandles | null): void {
  cached = handles;
}

/**
 * Store errors carry a numeric `.code` (404 not-found, 409 unique
 * conflict) and a string `.type` so callers can branch on the failure
 * kind. These two helpers are the canonical check — `document-store.ts`
 * deliberately throws these shapes so the branching code stays simple.
 */
export function isStoreErrorCode(err: unknown, code: number): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number; response?: { code?: number } };
  return e.code === code || e.response?.code === code;
}

export function isStoreErrorType(err: unknown, type: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: string; response?: { type?: string } };
  return e.type === type || e.response?.type === type;
}

/**
 * Collection (SQLite table) names — single source of truth so route
 * handlers don't pass typo'd strings to the store. The tables
 * themselves are created from `schema-spec.ts` by
 * `store/schema-bootstrap.ts`.
 */
export const COLLECTIONS = {
  users: "users",
  refreshTokens: "refresh_tokens",
  books: "books",
  bookChunks: "book_chunks",
  concepts: "concepts",
  userPreferences: "user_preferences",
  importJobs: "import_jobs",
  ingestJobs: "ingest_jobs",
  datasetJobs: "dataset_jobs",
  evaluatorEvents: "evaluator_events",
  auditLog: "audit_log",
} as const;

export const BUCKETS = {
  bookOriginals: "book-originals",
  bookMarkdowns: "book-markdowns",
  bookCovers: "book-covers",
  datasetExports: "dataset-exports",
} as const;
