/**
 * Single source of truth for the Bibliary data schema — collection
 * attributes, indexes, and storage buckets.
 *
 * Two bootstrap targets consume this:
 *   - `scripts/appwrite-bootstrap.ts` translates the specs into Appwrite
 *     collections / attributes / indexes / buckets (multi-user mode).
 *   - `server/lib/store/solo-bootstrap.ts` translates the same specs into
 *     SQLite `CREATE TABLE` / `CREATE INDEX` DDL + filesystem bucket
 *     directories (solo mode — no Appwrite).
 *
 * Keeping the spec here means the two bootstrap paths cannot drift: a
 * new attribute lands in both backends from one edit.
 */

export interface AttributeSpec {
  key: string;
  type: "string" | "integer" | "double" | "boolean" | "datetime" | "enum" | "email";
  required: boolean;
  array?: boolean;
  size?: number;
  elements?: string[];
  default?: string | number | boolean | null;
  min?: number;
  max?: number;
}

export interface IndexSpec {
  key: string;
  type: "key" | "unique" | "fulltext";
  attributes: string[];
  orders?: ("ASC" | "DESC")[];
}

export interface CollectionSpec {
  id: string;
  name: string;
  documentSecurity: boolean;
  attributes: AttributeSpec[];
  indexes: IndexSpec[];
}

export interface BucketSpec {
  id: string;
  name: string;
  permissions: string[];
  maximumFileSize: number;
  allowedExtensions: string[];
  fileSecurity: boolean;
  encryption: boolean;
  antivirus: boolean;
}

export const COLLECTION_SPECS: CollectionSpec[] = [
  {
    id: "users",
    name: "Users",
    documentSecurity: true,
    attributes: [
      { key: "email", type: "email", required: true },
      { key: "name", type: "string", required: false, size: 200 },
      { key: "passwordHash", type: "string", required: true, size: 200 },
      { key: "role", type: "enum", required: true, elements: ["user", "admin"], default: "user" },
      { key: "libraryQuotaBytes", type: "integer", required: false },
      { key: "createdAt", type: "datetime", required: true },
      { key: "lastLoginAt", type: "datetime", required: false },
      { key: "deactivated", type: "boolean", required: false, default: false },
    ],
    indexes: [
      { key: "email_unique", type: "unique", attributes: ["email"] },
      { key: "role_idx", type: "key", attributes: ["role"] },
    ],
  },
  {
    id: "refresh_tokens",
    name: "Refresh Tokens",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      { key: "tokenHash", type: "string", required: true, size: 128 },
      { key: "expiresAt", type: "datetime", required: true },
      { key: "revoked", type: "boolean", required: true, default: false },
      { key: "userAgent", type: "string", required: false, size: 500 },
      { key: "createdAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "tokenHash_unique", type: "unique", attributes: ["tokenHash"] },
      { key: "user_expires_idx", type: "key", attributes: ["userId", "expiresAt"] },
    ],
  },
  {
    id: "books",
    name: "Books",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      { key: "title", type: "string", required: true, size: 500 },
      { key: "titleRu", type: "string", required: false, size: 500 },
      { key: "author", type: "string", required: false, size: 300 },
      { key: "authorRu", type: "string", required: false, size: 300 },
      { key: "domain", type: "string", required: false, size: 100 },
      { key: "tags", type: "string", required: false, size: 50, array: true },
      { key: "tagsRu", type: "string", required: false, size: 50, array: true },
      { key: "language", type: "string", required: false, size: 8 },
      { key: "year", type: "integer", required: false },
      { key: "wordCount", type: "integer", required: false, default: 0 },
      {
        key: "status",
        type: "enum",
        required: true,
        elements: [
          "imported",
          "layout-cleaning",
          "evaluating",
          "evaluated",
          "crystallizing",
          "indexed",
          "failed",
          "unsupported",
        ],
        default: "imported",
      },
      { key: "qualityScore", type: "double", required: false, min: 0, max: 10 },
      { key: "isFictionOrWater", type: "boolean", required: false },
      { key: "conceptualDensity", type: "double", required: false },
      { key: "originality", type: "double", required: false },
      { key: "uniquenessScore", type: "double", required: false },
      { key: "verdictReason", type: "string", required: false, size: 2000 },
      { key: "evaluatorModel", type: "string", required: false, size: 200 },
      { key: "evaluatedAt", type: "datetime", required: false },
      { key: "markdownFileId", type: "string", required: false, size: 64 },
      { key: "originalFileId", type: "string", required: false, size: 64 },
      { key: "coverFileId", type: "string", required: false, size: 64 },
      { key: "originalExtension", type: "string", required: false, size: 16 },
      { key: "sha256", type: "string", required: true, size: 64 },
      { key: "createdAt", type: "datetime", required: true },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "user_status_idx", type: "key", attributes: ["userId", "status"] },
      { key: "user_sha_unique", type: "unique", attributes: ["userId", "sha256"] },
      { key: "user_quality_idx", type: "key", attributes: ["userId", "qualityScore"], orders: ["ASC", "DESC"] },
      { key: "user_created_idx", type: "key", attributes: ["userId", "createdAt"], orders: ["ASC", "DESC"] },
      { key: "fulltext_title", type: "fulltext", attributes: ["title", "titleRu", "author"] },
    ],
  },
  {
    id: "book_chunks",
    name: "Book Chunks",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      { key: "bookId", type: "string", required: true, size: 64 },
      { key: "chunkIndex", type: "integer", required: true },
      { key: "text", type: "string", required: true, size: 5000 },
      { key: "vectorRowId", type: "integer", required: true },
      { key: "createdAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "user_book_idx", type: "key", attributes: ["userId", "bookId", "chunkIndex"] },
      { key: "vector_row_unique", type: "unique", attributes: ["vectorRowId"] },
    ],
  },
  {
    id: "concepts",
    name: "Concepts",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      { key: "bookId", type: "string", required: true, size: 64 },
      { key: "collectionName", type: "string", required: true, size: 100 },
      { key: "payload", type: "string", required: true, size: 20000 },
      { key: "accepted", type: "boolean", required: true, default: false },
      { key: "vectorRowId", type: "integer", required: false },
      { key: "createdAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "user_collection_idx", type: "key", attributes: ["userId", "collectionName", "accepted"] },
      { key: "user_book_idx", type: "key", attributes: ["userId", "bookId"] },
    ],
  },
  {
    id: "user_preferences",
    name: "User Preferences",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      { key: "data", type: "string", required: true, size: 100000 },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    indexes: [{ key: "user_unique", type: "unique", attributes: ["userId"] }],
  },
  {
    id: "import_jobs",
    name: "Import Jobs",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      {
        key: "state",
        type: "enum",
        required: true,
        elements: ["queued", "running", "done", "failed", "cancelled"],
        default: "queued",
      },
      { key: "filesTotal", type: "integer", required: true, default: 0 },
      { key: "filesProcessed", type: "integer", required: true, default: 0 },
      { key: "filesFailed", type: "integer", required: true, default: 0 },
      { key: "currentFile", type: "string", required: false, size: 1000 },
      { key: "error", type: "string", required: false, size: 2000 },
      { key: "createdAt", type: "datetime", required: true },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "user_state_idx", type: "key", attributes: ["userId", "state"] },
      { key: "user_created_idx", type: "key", attributes: ["userId", "createdAt"], orders: ["DESC"] },
    ],
  },
  {
    id: "ingest_jobs",
    name: "Ingest Jobs",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      { key: "bookId", type: "string", required: false, size: 64 },
      {
        key: "state",
        type: "enum",
        required: true,
        elements: ["queued", "running", "done", "failed", "cancelled"],
        default: "queued",
      },
      { key: "stage", type: "string", required: false, size: 64 },
      { key: "progress", type: "double", required: true, default: 0 },
      { key: "message", type: "string", required: false, size: 1000 },
      { key: "error", type: "string", required: false, size: 2000 },
      { key: "createdAt", type: "datetime", required: true },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    indexes: [{ key: "user_state_idx", type: "key", attributes: ["userId", "state"] }],
  },
  {
    id: "dataset_jobs",
    name: "Dataset Jobs",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      { key: "batchId", type: "string", required: false, size: 64 },
      {
        key: "state",
        type: "enum",
        required: true,
        elements: ["queued", "running", "done", "failed", "cancelled"],
        default: "queued",
      },
      { key: "stage", type: "string", required: false, size: 64 },
      { key: "booksTotal", type: "integer", required: true, default: 0 },
      { key: "booksProcessed", type: "integer", required: true, default: 0 },
      { key: "conceptsExtracted", type: "integer", required: true, default: 0 },
      { key: "targetCollection", type: "string", required: false, size: 100 },
      { key: "extractModel", type: "string", required: false, size: 200 },
      { key: "exportFileId", type: "string", required: false, size: 64 },
      { key: "error", type: "string", required: false, size: 2000 },
      { key: "createdAt", type: "datetime", required: true },
      { key: "updatedAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "user_state_idx", type: "key", attributes: ["userId", "state"] },
      { key: "user_batch_idx", type: "key", attributes: ["userId", "batchId"] },
    ],
  },
  {
    id: "evaluator_events",
    name: "Evaluator Events",
    documentSecurity: true,
    attributes: [
      { key: "userId", type: "string", required: true, size: 64 },
      { key: "bookId", type: "string", required: true, size: 64 },
      {
        key: "event",
        type: "enum",
        required: true,
        elements: ["started", "done", "failed", "skipped"],
      },
      { key: "payload", type: "string", required: false, size: 5000 },
      { key: "createdAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "user_book_idx", type: "key", attributes: ["userId", "bookId"] },
      { key: "user_created_idx", type: "key", attributes: ["userId", "createdAt"], orders: ["DESC"] },
    ],
  },
  {
    id: "audit_log",
    name: "Audit Log",
    documentSecurity: false,
    attributes: [
      { key: "userId", type: "string", required: false, size: 64 },
      { key: "action", type: "string", required: true, size: 100 },
      { key: "target", type: "string", required: false, size: 200 },
      { key: "metadata", type: "string", required: false, size: 5000 },
      { key: "ip", type: "string", required: false, size: 64 },
      { key: "userAgent", type: "string", required: false, size: 500 },
      { key: "createdAt", type: "datetime", required: true },
    ],
    indexes: [
      { key: "action_created_idx", type: "key", attributes: ["action", "createdAt"], orders: ["ASC", "DESC"] },
      { key: "user_created_idx", type: "key", attributes: ["userId", "createdAt"], orders: ["ASC", "DESC"] },
    ],
  },
];

const FIVE_GB = 5_000_000_000;
const TEN_MB = 10_000_000;

export const BUCKET_SPECS: BucketSpec[] = [
  {
    id: "book-originals",
    name: "Book Originals",
    permissions: [],
    maximumFileSize: FIVE_GB,
    allowedExtensions: [
      "pdf",
      "epub",
      "djvu",
      "djv",
      "mobi",
      "azw3",
      "azw",
      "fb2",
      "docx",
      "doc",
      "odt",
      "rtf",
      "txt",
      "html",
      "htm",
      "chm",
      "cbz",
      "zip",
      "7z",
      "rar",
    ],
    fileSecurity: true,
    encryption: false,
    antivirus: false,
  },
  {
    id: "book-markdowns",
    name: "Book Markdowns",
    permissions: [],
    maximumFileSize: TEN_MB,
    allowedExtensions: ["md", "markdown"],
    fileSecurity: true,
    encryption: false,
    antivirus: false,
  },
  {
    id: "book-covers",
    name: "Book Covers",
    permissions: [],
    maximumFileSize: TEN_MB,
    allowedExtensions: ["jpg", "jpeg", "png", "webp", "gif"],
    fileSecurity: true,
    encryption: false,
    antivirus: false,
  },
  {
    id: "dataset-exports",
    name: "Dataset Exports",
    permissions: [],
    maximumFileSize: FIVE_GB,
    allowedExtensions: ["jsonl", "json", "zip", "gz", "tar"],
    fileSecurity: true,
    encryption: false,
    antivirus: false,
  },
];
