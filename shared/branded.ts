/**
 * Branded primitive types — TypeScript's idiomatic way to prevent
 * accidentally passing one kind of string where another is expected.
 *
 * Why brands? Bibliary passes a LOT of identifier-shaped strings
 * around:
 *   - `userId` (Appwrite user id, 20 chars)
 *   - `bookId` (Appwrite books document id, 20 chars)
 *   - `jobId`  (Appwrite dataset_jobs document id, 20 chars)
 *   - `collectionName` (free-form user-supplied string, regex-validated)
 *   - `entityId` (sqlite integer, but we cast to/from string in some
 *     SSE payloads)
 *   - `vecRowid` (sqlite-vec rowid, integer-but-stringly-handled
 *     in some places)
 *
 * Without brands these are all `string`, and the compiler can't catch
 * `deleteBook(userId, bookId)` invoked as `deleteBook(bookId, userId)`.
 * Branded types make them mutually incompatible at the type system
 * level while staying erased at runtime (zero perf cost).
 *
 * Adoption is opt-in. Existing call sites keep using `string` and
 * compile fine — branded types are SUPERtypes of string in usage
 * (you can pass a UserId where string is expected) but SUBTYPES at
 * declaration (you can't pass a bare string where UserId is required).
 * Refactor a hot module at a time; don't try to brand the world in
 * one commit.
 *
 * Pattern:
 *
 *   import { type UserId, asUserId } from "../../shared/branded.js";
 *
 *   // At a boundary (HTTP route, DB read):
 *   const userId = asUserId(c.get("user").sub);
 *
 *   // Internal functions accept the branded version:
 *   async function getBookById(userId: UserId, bookId: BookId): Promise<...>
 *
 *   // Errors at compile-time when you swap them:
 *   getBookById(bookId, userId);  // tsc error
 */

/**
 * Compile-time-only brand. The `__brand` field is phantom — never set
 * at runtime; it only lives in the type system. Using `unique symbol`
 * brands would prevent structural equality which we sometimes need
 * (e.g. Map<UserId, X> lookups by raw string), so we use a string
 * literal brand instead.
 */
declare const __brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [__brand]: B };

/** Appwrite user document id. */
export type UserId = Branded<string, "UserId">;

/** Appwrite books document id. */
export type BookId = Branded<string, "BookId">;

/** Appwrite dataset_jobs document id. */
export type JobId = Branded<string, "JobId">;

/** Appwrite concepts document id. */
export type ConceptId = Branded<string, "ConceptId">;

/** sqlite-vec rowid for chunks_vec / concepts_vec. */
export type VecRowId = Branded<number, "VecRowId">;

/** Free-form vectordb collection name; routes regex-validate before
 * casting. */
export type CollectionName = Branded<string, "CollectionName">;

/** Entity id in the Δ-topology relations graph. */
export type EntityId = Branded<number, "EntityId">;

/* ────────────────────────────────────────────────────────────────── */
/* Cast helpers — zero-cost wrappers that document intent.            */
/* ────────────────────────────────────────────────────────────────── */

export const asUserId = (s: string): UserId => s as UserId;
export const asBookId = (s: string): BookId => s as BookId;
export const asJobId = (s: string): JobId => s as JobId;
export const asConceptId = (s: string): ConceptId => s as ConceptId;
export const asVecRowId = (n: number): VecRowId => n as VecRowId;
export const asCollectionName = (s: string): CollectionName => s as CollectionName;
export const asEntityId = (n: number): EntityId => n as EntityId;

/* ────────────────────────────────────────────────────────────────── */
/* Format guards — narrow at trust boundaries (HTTP body, DB row).    */
/* These do RUNTIME validation, unlike the casts above. Use them only */
/* when ingesting from outside the system.                            */
/* ────────────────────────────────────────────────────────────────── */

const APPWRITE_ID_RE = /^[a-zA-Z0-9_]{1,36}$/;

export function isValidAppwriteId(s: unknown): s is string {
  return typeof s === "string" && APPWRITE_ID_RE.test(s);
}

export function parseUserId(s: unknown): UserId | null {
  return isValidAppwriteId(s) ? (s as UserId) : null;
}

export function parseBookId(s: unknown): BookId | null {
  return isValidAppwriteId(s) ? (s as BookId) : null;
}

export function parseJobId(s: unknown): JobId | null {
  return isValidAppwriteId(s) ? (s as JobId) : null;
}

const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,100}$/;

export function parseCollectionName(s: unknown): CollectionName | null {
  return typeof s === "string" && COLLECTION_RE.test(s) ? (s as CollectionName) : null;
}
