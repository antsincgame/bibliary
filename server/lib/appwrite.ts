import { Client, Databases, Storage, Users } from "node-appwrite";

import { type Config, loadConfig } from "../config.js";

/**
 * Bare fields Appwrite stamps onto every document. Use as `RawDoc & MyFields`
 * so generic methods like `databases.getDocument<T>()` accept our types.
 */
export interface RawDoc {
  $id: string;
  $collectionId: string;
  $databaseId: string;
  $createdAt: string;
  $updatedAt: string;
  $permissions: string[];
}

interface AppwriteHandles {
  client: Client;
  databases: Databases;
  storage: Storage;
  users: Users;
  databaseId: string;
}

let cached: AppwriteHandles | null = null;

/**
 * Server-side Appwrite handles using the admin API key. ALL backend code
 * must go through these — never instantiate `new Client()` ad-hoc, because
 * tests rely on swapping `cached` via `setAppwriteHandlesForTesting`.
 */
export function getAppwrite(cfg: Config = loadConfig()): AppwriteHandles {
  if (cached) return cached;

  const client = new Client()
    .setEndpoint(cfg.APPWRITE_ENDPOINT)
    .setProject(cfg.APPWRITE_PROJECT_ID)
    .setKey(cfg.APPWRITE_API_KEY);

  cached = {
    client,
    databases: new Databases(client),
    storage: new Storage(client),
    users: new Users(client),
    databaseId: cfg.APPWRITE_DATABASE_ID,
  };
  return cached;
}

export function setAppwriteHandlesForTesting(handles: AppwriteHandles | null): void {
  cached = handles;
}

export function isAppwriteCode(err: unknown, code: number): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number; response?: { code?: number } };
  return e.code === code || e.response?.code === code;
}

export function isAppwriteType(err: unknown, type: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: string; response?: { type?: string } };
  return e.type === type || e.response?.type === type;
}

/**
 * Names of Appwrite collections — single source of truth so route handlers
 * don't pass typo'd strings to the SDK.
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
