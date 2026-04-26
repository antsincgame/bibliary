import { openCacheDb } from "./cache-db-connection.js";
import type { BookCatalogMeta, BookStatus } from "./types.js";
import { type BookRow, rowToMeta, type CatalogQuery, type QueryResult, type RevisionDedupBook } from "./cache-db-types.js";

const DEFAULT_CATALOG_LIMIT = 500;
const MAX_CATALOG_LIMIT = 20_000;

function buildWhere(q: CatalogQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof q.minQuality === "number") {
    where.push("books.quality_score >= ?");
    params.push(q.minQuality);
  }
  if (typeof q.maxQuality === "number") {
    where.push("books.quality_score <= ?");
    params.push(q.maxQuality);
  }
  if (q.hideFictionOrWater) {
    where.push("(books.is_fiction_or_water IS NULL OR books.is_fiction_or_water = 0)");
  }
  if (q.statuses && q.statuses.length > 0) {
    const placeholders = q.statuses.map(() => "?").join(",");
    where.push(`books.status IN (${placeholders})`);
    params.push(...q.statuses);
  }
  if (q.domain) {
    where.push("books.domain = ?");
    params.push(q.domain);
  }
  return { sql: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, params };
}

function buildOrderBy(q: CatalogQuery): string {
  const dir = (q.orderDir ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";
  switch (q.orderBy) {
    case "title":
      return `ORDER BY COALESCE(books.title_en, books.title) ${dir}`;
    case "words":
      return `ORDER BY books.word_count ${dir}`;
    case "evaluated":
      return `ORDER BY COALESCE(books.evaluated_at, '') ${dir}, books.title`;
    case "quality":
    default:
      return `ORDER BY books.quality_score ${dir} NULLS LAST, COALESCE(books.title_en, books.title)`;
  }
}

export function query(q: CatalogQuery = {}): QueryResult {
  const db = openCacheDb();
  const { sql: whereSql, params: whereParams } = buildWhere(q);
  const orderSql = buildOrderBy(q);
  const limit = Math.max(0, Math.min(q.limit ?? DEFAULT_CATALOG_LIMIT, MAX_CATALOG_LIMIT));
  const offset = Math.max(0, q.offset ?? 0);

  let baseFrom = "FROM books";
  const extraJoinParams: unknown[] = [];
  if (q.search && q.search.trim().length > 0) {
    baseFrom = "FROM books JOIN books_fts ON books.rowid = books_fts.rowid";
  }

  const ftsClause = q.search && q.search.trim().length > 0 ? "books_fts MATCH ?" : "";
  const allWhere: string[] = [];
  const allParams: unknown[] = [...extraJoinParams];
  if (whereSql) {
    allWhere.push(whereSql.replace(/^WHERE\s+/, ""));
    allParams.push(...whereParams);
  }
  if (ftsClause) {
    allWhere.push(ftsClause);
    allParams.push(q.search!.trim());
  }
  const finalWhere = allWhere.length > 0 ? `WHERE ${allWhere.join(" AND ")}` : "";

  const countSql = `SELECT COUNT(*) AS n ${baseFrom} ${finalWhere}`;
  const total = (db.prepare(countSql).get(...allParams) as { n: number }).n;

  const dataSql = `SELECT books.* ${baseFrom} ${finalWhere} ${orderSql} LIMIT ? OFFSET ?`;
  const rows = db.prepare(dataSql).all(...allParams, limit, offset) as BookRow[];

  const ids = rows.map((r) => r.id);
  const tagMap = new Map<string, string[]>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const tagRows = db
      .prepare(`SELECT book_id, tag FROM book_tags WHERE book_id IN (${placeholders})`)
      .all(...ids) as Array<{ book_id: string; tag: string }>;
    for (const tr of tagRows) {
      const arr = tagMap.get(tr.book_id) ?? [];
      arr.push(tr.tag);
      tagMap.set(tr.book_id, arr);
    }
  }

  const result = rows.map((r) => rowToMeta(r, tagMap.get(r.id) ?? []));
  return { rows: result, total };
}

export function getBookById(id: string): (BookCatalogMeta & { mdPath: string }) | null {
  const db = openCacheDb();
  const row = db.prepare("SELECT * FROM books WHERE id = ?").get(id) as BookRow | undefined;
  if (!row) return null;
  const tags = (db.prepare("SELECT tag FROM book_tags WHERE book_id = ?").all(id) as Array<{ tag: string }>).map((t) => t.tag);
  return rowToMeta(row, tags);
}

export function streamBookIdsByStatus(
  statuses: BookStatus[],
  batchSize: number,
  lastId: string | null,
): { ids: string[]; nextCursor: string | null } {
  if (statuses.length === 0 || batchSize <= 0) return { ids: [], nextCursor: null };
  const db = openCacheDb();
  const placeholders = statuses.map(() => "?").join(",");
  const params: unknown[] = [...statuses];
  let where = `status IN (${placeholders})`;
  if (lastId !== null) {
    where += " AND id > ?";
    params.push(lastId);
  }
  params.push(batchSize);
  const rows = db
    .prepare(`SELECT id FROM books WHERE ${where} ORDER BY id ASC LIMIT ?`)
    .all(...params) as Array<{ id: string }>;
  const ids = rows.map((r) => r.id);
  const nextCursor = ids.length === batchSize ? ids[ids.length - 1] : null;
  return { ids, nextCursor };
}

export function getBooksByIds(ids: string[]): (BookCatalogMeta & { mdPath: string })[] {
  if (ids.length === 0) return [];
  const db = openCacheDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM books WHERE id IN (${placeholders})`)
    .all(...ids) as BookRow[];
  const byId = new Map<string, BookRow>(rows.map((r) => [r.id, r]));
  const out: (BookCatalogMeta & { mdPath: string })[] = [];
  const tagStmt = db.prepare("SELECT tag FROM book_tags WHERE book_id = ?");
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const tags = (tagStmt.all(id) as Array<{ tag: string }>).map((t) => t.tag);
    out.push(rowToMeta(row, tags));
  }
  return out;
}

export function listBooksForRevisionDedup(): RevisionDedupBook[] {
  const db = openCacheDb();
  const rows = db.prepare(
    "SELECT id, title, author, title_en, author_en, source_archive, year, isbn FROM books"
  ).all() as Array<{
    id: string;
    title: string;
    author: string | null;
    title_en: string | null;
    author_en: string | null;
    source_archive: string | null;
    year: number | null;
    isbn: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    author: r.author ?? undefined,
    titleEn: r.title_en ?? undefined,
    authorEn: r.author_en ?? undefined,
    sourceArchive: r.source_archive ?? undefined,
    year: r.year ?? undefined,
    isbn: r.isbn ?? undefined,
  }));
}

/** Aggregate tag counts across all evaluated books. */
export function queryTagStats(): { tag: string; count: number }[] {
  const db = openCacheDb();
  return db.prepare(`
    SELECT tag, COUNT(*) as count
    FROM book_tags
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `).all() as { tag: string; count: number }[];
}

// ─── Collection Views (Phase 3: virtual views from SQLite) ───────────

export interface CollectionGroup {
  label: string;
  count: number;
  bookIds: string[];
}

/** Group books by AI-assigned domain. */
export function queryByDomain(): CollectionGroup[] {
  const db = openCacheDb();
  const rows = db.prepare(`
    SELECT COALESCE(domain, 'unclassified') as label, COUNT(*) as count,
           GROUP_CONCAT(id) as ids
    FROM books
    GROUP BY label
    ORDER BY count DESC, label ASC
  `).all() as Array<{ label: string; count: number; ids: string }>;
  return rows.map((r) => ({
    label: r.label,
    count: r.count,
    bookIds: r.ids ? r.ids.split(",") : [],
  }));
}

/** Group books by author. */
export function queryByAuthor(): CollectionGroup[] {
  const db = openCacheDb();
  const rows = db.prepare(`
    SELECT COALESCE(COALESCE(author_en, author), 'Unknown Author') as label,
           COUNT(*) as count, GROUP_CONCAT(id) as ids
    FROM books
    GROUP BY label
    ORDER BY count DESC, label ASC
  `).all() as Array<{ label: string; count: number; ids: string }>;
  return rows.map((r) => ({
    label: r.label,
    count: r.count,
    bookIds: r.ids ? r.ids.split(",") : [],
  }));
}

/** Group books by publication year. */
export function queryByYear(): CollectionGroup[] {
  const db = openCacheDb();
  const rows = db.prepare(`
    SELECT COALESCE(CAST(year AS TEXT), 'Unknown Year') as label,
           COUNT(*) as count, GROUP_CONCAT(id) as ids
    FROM books
    WHERE year IS NOT NULL
    GROUP BY year
    ORDER BY year DESC
  `).all() as Array<{ label: string; count: number; ids: string }>;

  const unknown = db.prepare(`
    SELECT COUNT(*) as count, GROUP_CONCAT(id) as ids
    FROM books WHERE year IS NULL
  `).get() as { count: number; ids: string | null };

  const result = rows.map((r) => ({
    label: r.label,
    count: r.count,
    bookIds: r.ids ? r.ids.split(",") : [],
  }));

  if (unknown.count > 0) {
    result.push({
      label: "Unknown Year",
      count: unknown.count,
      bookIds: unknown.ids ? unknown.ids.split(",") : [],
    });
  }

  return result;
}

/** Group books by sphere (import folder domain). */
export function queryBySphere(): CollectionGroup[] {
  const db = openCacheDb();
  const rows = db.prepare(`
    SELECT COALESCE(sphere, 'unsorted') as label, COUNT(*) as count,
           GROUP_CONCAT(id) as ids
    FROM books
    GROUP BY label
    ORDER BY count DESC, label ASC
  `).all() as Array<{ label: string; count: number; ids: string }>;
  return rows.map((r) => ({
    label: r.label,
    count: r.count,
    bookIds: r.ids ? r.ids.split(",") : [],
  }));
}

/** Group books by LLM-assigned tag (by-tag with bookIds for filtering). */
export function queryByTag(): CollectionGroup[] {
  const db = openCacheDb();
  const rows = db.prepare(`
    SELECT bt.tag as label, COUNT(*) as count, GROUP_CONCAT(bt.book_id) as ids
    FROM book_tags bt
    GROUP BY bt.tag
    ORDER BY count DESC, bt.tag ASC
  `).all() as Array<{ label: string; count: number; ids: string }>;
  return rows.map((r) => ({
    label: r.label,
    count: r.count,
    bookIds: r.ids ? r.ids.split(",") : [],
  }));
}
