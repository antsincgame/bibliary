import { ID, Permission, Query, Role } from "node-appwrite";

import { COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";

export type BookStatus =
  | "imported"
  | "layout-cleaning"
  | "evaluating"
  | "evaluated"
  | "crystallizing"
  | "indexed"
  | "failed"
  | "unsupported";

export interface BookDoc {
  id: string;
  userId: string;
  title: string;
  titleRu: string | null;
  author: string | null;
  authorRu: string | null;
  domain: string | null;
  tags: string[];
  tagsRu: string[];
  language: string | null;
  year: number | null;
  wordCount: number;
  status: BookStatus;
  qualityScore: number | null;
  isFictionOrWater: boolean | null;
  conceptualDensity: number | null;
  originality: number | null;
  uniquenessScore: number | null;
  verdictReason: string | null;
  evaluatorModel: string | null;
  evaluatedAt: string | null;
  markdownFileId: string | null;
  originalFileId: string | null;
  coverFileId: string | null;
  originalExtension: string | null;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

type RawBookDoc = RawDoc & {
  userId: string;
  title: string;
  titleRu?: string;
  author?: string;
  authorRu?: string;
  domain?: string;
  tags?: string[];
  tagsRu?: string[];
  language?: string;
  year?: number;
  wordCount?: number;
  status: BookStatus;
  qualityScore?: number;
  isFictionOrWater?: boolean;
  conceptualDensity?: number;
  originality?: number;
  uniquenessScore?: number;
  verdictReason?: string;
  evaluatorModel?: string;
  evaluatedAt?: string;
  markdownFileId?: string;
  originalFileId?: string;
  coverFileId?: string;
  originalExtension?: string;
  sha256: string;
  createdAt: string;
  updatedAt: string;
};

function toBook(raw: RawBookDoc): BookDoc {
  return {
    id: raw.$id,
    userId: raw.userId,
    title: raw.title,
    titleRu: raw.titleRu ?? null,
    author: raw.author ?? null,
    authorRu: raw.authorRu ?? null,
    domain: raw.domain ?? null,
    tags: raw.tags ?? [],
    tagsRu: raw.tagsRu ?? [],
    language: raw.language ?? null,
    year: raw.year ?? null,
    wordCount: raw.wordCount ?? 0,
    status: raw.status,
    qualityScore: raw.qualityScore ?? null,
    isFictionOrWater: raw.isFictionOrWater ?? null,
    conceptualDensity: raw.conceptualDensity ?? null,
    originality: raw.originality ?? null,
    uniquenessScore: raw.uniquenessScore ?? null,
    verdictReason: raw.verdictReason ?? null,
    evaluatorModel: raw.evaluatorModel ?? null,
    evaluatedAt: raw.evaluatedAt ?? null,
    markdownFileId: raw.markdownFileId ?? null,
    originalFileId: raw.originalFileId ?? null,
    coverFileId: raw.coverFileId ?? null,
    originalExtension: raw.originalExtension ?? null,
    sha256: raw.sha256,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export interface CatalogQuery {
  search?: string;
  minQuality?: number;
  maxQuality?: number;
  hideFictionOrWater?: boolean;
  statuses?: BookStatus[];
  domain?: string;
  orderBy?: "quality" | "title" | "words" | "evaluated";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface CatalogResult {
  rows: BookDoc[];
  total: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function buildOrderQueries(orderBy: CatalogQuery["orderBy"], orderDir: CatalogQuery["orderDir"]): string[] {
  const dir = orderDir === "asc" ? Query.orderAsc : Query.orderDesc;
  switch (orderBy) {
    case "title":
      return [dir("title")];
    case "words":
      return [dir("wordCount")];
    case "evaluated":
      return [dir("evaluatedAt")];
    case "quality":
    default:
      return [dir("qualityScore"), Query.orderDesc("updatedAt")];
  }
}

export async function queryCatalog(userId: string, q: CatalogQuery = {}): Promise<CatalogResult> {
  const { databases, databaseId } = getAppwrite();
  const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, q.offset ?? 0);

  const queries: string[] = [Query.equal("userId", userId)];
  if (q.search) {
    queries.push(Query.search("title", q.search));
  }
  if (q.minQuality !== undefined) {
    queries.push(Query.greaterThanEqual("qualityScore", q.minQuality));
  }
  if (q.maxQuality !== undefined) {
    queries.push(Query.lessThanEqual("qualityScore", q.maxQuality));
  }
  if (q.hideFictionOrWater) {
    queries.push(Query.notEqual("isFictionOrWater", true));
  }
  if (q.statuses && q.statuses.length > 0) {
    queries.push(Query.equal("status", q.statuses));
  }
  if (q.domain) {
    queries.push(Query.equal("domain", q.domain));
  }
  queries.push(...buildOrderQueries(q.orderBy, q.orderDir));
  queries.push(Query.limit(limit));
  queries.push(Query.offset(offset));

  const list = await databases.listDocuments<RawBookDoc>(
    databaseId,
    COLLECTIONS.books,
    queries,
  );
  return {
    rows: list.documents.map(toBook),
    total: list.total,
  };
}

export async function getBookById(userId: string, bookId: string): Promise<BookDoc | null> {
  const { databases, databaseId } = getAppwrite();
  try {
    const raw = await databases.getDocument<RawBookDoc>(databaseId, COLLECTIONS.books, bookId);
    if (raw.userId !== userId) return null;
    return toBook(raw);
  } catch (err) {
    if (isAppwriteCode(err, 404)) return null;
    throw err;
  }
}

export async function deleteBook(userId: string, bookId: string): Promise<boolean> {
  const book = await getBookById(userId, bookId);
  if (!book) return false;
  const { databases, databaseId } = getAppwrite();
  await databases.deleteDocument(databaseId, COLLECTIONS.books, bookId);
  return true;
}

export interface CreateBookInput {
  userId: string;
  title: string;
  sha256: string;
  status?: BookStatus;
  titleRu?: string;
  author?: string;
  authorRu?: string;
  domain?: string;
  tags?: string[];
  tagsRu?: string[];
  language?: string;
  year?: number;
  wordCount?: number;
  markdownFileId?: string;
  originalFileId?: string;
  coverFileId?: string;
  originalExtension?: string;
}

export async function createBook(input: CreateBookInput): Promise<BookDoc> {
  const { databases, databaseId } = getAppwrite();
  const id = ID.unique();
  const nowIso = new Date().toISOString();
  const doc: Record<string, unknown> = {
    userId: input.userId,
    title: input.title.slice(0, 500),
    sha256: input.sha256,
    status: input.status ?? "imported",
    wordCount: input.wordCount ?? 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (input.titleRu) doc["titleRu"] = input.titleRu.slice(0, 500);
  if (input.author) doc["author"] = input.author.slice(0, 300);
  if (input.authorRu) doc["authorRu"] = input.authorRu.slice(0, 300);
  if (input.domain) doc["domain"] = input.domain.slice(0, 100);
  if (input.tags?.length) doc["tags"] = input.tags;
  if (input.tagsRu?.length) doc["tagsRu"] = input.tagsRu;
  if (input.language) doc["language"] = input.language;
  if (input.year !== undefined) doc["year"] = input.year;
  if (input.markdownFileId) doc["markdownFileId"] = input.markdownFileId;
  if (input.originalFileId) doc["originalFileId"] = input.originalFileId;
  if (input.coverFileId) doc["coverFileId"] = input.coverFileId;
  if (input.originalExtension) doc["originalExtension"] = input.originalExtension;

  const raw = await databases.createDocument<RawBookDoc>(
    databaseId,
    COLLECTIONS.books,
    id,
    doc,
    [
      Permission.read(Role.user(input.userId)),
      Permission.update(Role.user(input.userId)),
      Permission.delete(Role.user(input.userId)),
      Permission.read(Role.team("admin")),
    ],
  );
  return toBook(raw);
}

export interface UpdateBookInput {
  title?: string;
  titleRu?: string;
  author?: string;
  authorRu?: string;
  status?: BookStatus;
  qualityScore?: number | null;
  isFictionOrWater?: boolean | null;
  conceptualDensity?: number | null;
  originality?: number | null;
  evaluatorModel?: string | null;
  evaluatedAt?: string | null;
  verdictReason?: string | null;
  wordCount?: number;
  domain?: string | null;
  language?: string;
  year?: number | null;
  tags?: string[];
  tagsRu?: string[];
}

export async function updateBook(
  userId: string,
  bookId: string,
  patch: UpdateBookInput,
): Promise<BookDoc | null> {
  const existing = await getBookById(userId, bookId);
  if (!existing) return null;
  const { databases, databaseId } = getAppwrite();
  const doc: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) doc[k] = v;
  }
  const raw = await databases.updateDocument<RawBookDoc>(
    databaseId,
    COLLECTIONS.books,
    bookId,
    doc,
  );
  return toBook(raw);
}
