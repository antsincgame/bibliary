/**
 * Library Cache DB — SQLite UI index over the file-system library.
 *
 * Source of truth: `data/library/{slug}/book.md` (YAML frontmatter + body).
 * This DB is rebuildable: delete `bibliary-cache.db`, restart, scan all .md
 * files via `rebuildFromFs()` -- and the catalog is back.
 *
 * Schema is denormalised on purpose: every column the UI DataGrid needs is
 * one SELECT away. FTS5 covers free-text search across English mirrors and
 * evaluator artefacts.
 */

import Database from "better-sqlite3";
import { promises as fs, mkdirSync } from "fs";
import * as path from "path";
import { parseFrontmatter } from "./md-converter.js";
import { getLibraryRoot, resolveLibraryRoot } from "./paths.js";
import type { BookCatalogMeta, BookStatus } from "./types.js";

let cachedDb: Database.Database | null = null;
let cachedDbPath: string | null = null;

/** Полный путь к файлу БД. По умолчанию рядом с library/. */
function resolveDbPath(): string {
  const fromEnv = process.env.BIBLIARY_LIBRARY_DB?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  /* `data/bibliary-cache.db` -- сосед library/. Не внутри -- чтобы юзер не
     удалил случайно вместе с книгами. */
  const dataDir = process.env.BIBLIARY_DATA_DIR?.trim();
  if (dataDir) return path.resolve(dataDir, "bibliary-cache.db");
  /* Fallback: <projectRoot>/data/bibliary-cache.db. paths.ts уже умеет это. */
  return path.resolve(path.dirname(resolveLibraryRoot()), "bibliary-cache.db");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS books (
  id                  TEXT PRIMARY KEY,
  sha256              TEXT UNIQUE NOT NULL,
  -- bibliographic
  title               TEXT NOT NULL,
  author              TEXT,
  title_en            TEXT,
  author_en           TEXT,
  -- structure
  word_count          INTEGER NOT NULL,
  chapter_count       INTEGER NOT NULL,
  original_format     TEXT NOT NULL,
  source_archive      TEXT,
  -- evaluator
  domain              TEXT,
  quality_score       INTEGER,
  conceptual_density  INTEGER,
  originality         INTEGER,
  is_fiction_or_water INTEGER,
  verdict_reason      TEXT,
  evaluator_reasoning TEXT,
  evaluator_model     TEXT,
  evaluated_at        TEXT,
  -- crystallizer
  concepts_extracted  INTEGER,
  concepts_accepted   INTEGER,
  -- lifecycle
  status              TEXT NOT NULL,
  md_path             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_tags (
  book_id TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (book_id, tag),
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_books_quality ON books(quality_score);
CREATE INDEX IF NOT EXISTS idx_books_status  ON books(status);
CREATE INDEX IF NOT EXISTS idx_books_domain  ON books(domain);
CREATE INDEX IF NOT EXISTS idx_books_fiction ON books(is_fiction_or_water);
CREATE INDEX IF NOT EXISTS idx_book_tags_tag ON book_tags(tag);

CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
  title_en, author_en, tags, verdict_reason, evaluator_reasoning
);
`;

/**
 * Schema-version миграции (PRAGMA user_version).
 *
 *   v0 → v1: первичная схема (выше в SCHEMA_SQL).
 *   v1 → v2: пересоздать books_fts без `content=''`.
 *           Contentless FTS5 запрещает обычный DELETE → upsertBook падал.
 *           Тест поймал это в Iter 7 (`library import failed: cannot DELETE
 *           from contentless fts5 table: books_fts`).
 *
 * Миграции применяются один раз при первом open. Idempotent.
 */
function applyMigrations(db: Database.Database): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;

  if (current < 2) {
    /* DROP старой contentless FTS5 (если есть) и пересоздание как полноценной. */
    db.exec(`
      DROP TABLE IF EXISTS books_fts;
      CREATE VIRTUAL TABLE books_fts USING fts5(
        title_en, author_en, tags, verdict_reason, evaluator_reasoning
      );
    `);
    /* Перенаполняем FTS из текущих books (если они уже есть в БД от старой версии). */
    db.exec(`
      INSERT INTO books_fts (rowid, title_en, author_en, tags, verdict_reason, evaluator_reasoning)
      SELECT b.rowid,
             COALESCE(b.title_en, b.title),
             COALESCE(b.author_en, b.author, ''),
             COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM book_tags WHERE book_id = b.id), ''),
             COALESCE(b.verdict_reason, ''),
             COALESCE(b.evaluator_reasoning, '')
        FROM books b;
    `);
    db.pragma("user_version = 2");
  }
}

/** Открывает (или создаёт) БД и применяет миграции. Идемпотентно. */
export function openCacheDb(): Database.Database {
  const wantedPath = resolveDbPath();
  if (cachedDb && cachedDbPath === wantedPath) return cachedDb;
  if (cachedDb && cachedDbPath !== wantedPath) {
    cachedDb.close();
    cachedDb = null;
  }
  const dir = path.dirname(wantedPath);
  /* mkdirSync через fs/promises невозможен sync -- но better-sqlite3 сам не
     создаёт parent dir. Используем sync API через статический import. */
  mkdirSync(dir, { recursive: true });
  const db = new Database(wantedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  cachedDb = db;
  cachedDbPath = wantedPath;
  return db;
}

/** Закрывает БД (для тестов и shutdown). */
export function closeCacheDb(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedDbPath = null;
  }
}

/** Возвращает путь к БД (для логов и UI Settings). */
export function getCacheDbPath(): string {
  return cachedDbPath ?? resolveDbPath();
}

// ── Domain mapping helpers ──────────────────────────────────────────────────

interface BookRow {
  id: string;
  sha256: string;
  title: string;
  author: string | null;
  title_en: string | null;
  author_en: string | null;
  word_count: number;
  chapter_count: number;
  original_format: string;
  source_archive: string | null;
  domain: string | null;
  quality_score: number | null;
  conceptual_density: number | null;
  originality: number | null;
  is_fiction_or_water: number | null;
  verdict_reason: string | null;
  evaluator_reasoning: string | null;
  evaluator_model: string | null;
  evaluated_at: string | null;
  concepts_extracted: number | null;
  concepts_accepted: number | null;
  status: string;
  md_path: string;
}

function rowToMeta(row: BookRow, tags: string[]): BookCatalogMeta & { mdPath: string } {
  return {
    id: row.id,
    sha256: row.sha256,
    title: row.title,
    author: row.author ?? undefined,
    titleEn: row.title_en ?? undefined,
    authorEn: row.author_en ?? undefined,
    wordCount: row.word_count,
    chapterCount: row.chapter_count,
    originalFile: "", /* не сохраняем -- UI не показывает */
    originalFormat: row.original_format as BookCatalogMeta["originalFormat"],
    sourceArchive: row.source_archive ?? undefined,
    domain: row.domain ?? undefined,
    tags: tags.length > 0 ? tags : undefined,
    qualityScore: row.quality_score ?? undefined,
    conceptualDensity: row.conceptual_density ?? undefined,
    originality: row.originality ?? undefined,
    isFictionOrWater: row.is_fiction_or_water === null ? undefined : row.is_fiction_or_water === 1,
    verdictReason: row.verdict_reason ?? undefined,
    evaluatorReasoning: row.evaluator_reasoning ?? undefined,
    evaluatorModel: row.evaluator_model ?? undefined,
    evaluatedAt: row.evaluated_at ?? undefined,
    conceptsExtracted: row.concepts_extracted ?? undefined,
    conceptsAccepted: row.concepts_accepted ?? undefined,
    status: row.status as BookStatus,
    mdPath: row.md_path,
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────

const UPSERT_SQL = `
INSERT INTO books (
  id, sha256, title, author, title_en, author_en, word_count, chapter_count,
  original_format, source_archive, domain, quality_score, conceptual_density,
  originality, is_fiction_or_water, verdict_reason, evaluator_reasoning,
  evaluator_model, evaluated_at, concepts_extracted, concepts_accepted,
  status, md_path
) VALUES (
  @id, @sha256, @title, @author, @title_en, @author_en, @word_count, @chapter_count,
  @original_format, @source_archive, @domain, @quality_score, @conceptual_density,
  @originality, @is_fiction_or_water, @verdict_reason, @evaluator_reasoning,
  @evaluator_model, @evaluated_at, @concepts_extracted, @concepts_accepted,
  @status, @md_path
)
ON CONFLICT(id) DO UPDATE SET
  sha256              = excluded.sha256,
  title               = excluded.title,
  author              = excluded.author,
  title_en            = excluded.title_en,
  author_en           = excluded.author_en,
  word_count          = excluded.word_count,
  chapter_count       = excluded.chapter_count,
  original_format     = excluded.original_format,
  source_archive      = excluded.source_archive,
  domain              = excluded.domain,
  quality_score       = excluded.quality_score,
  conceptual_density  = excluded.conceptual_density,
  originality         = excluded.originality,
  is_fiction_or_water = excluded.is_fiction_or_water,
  verdict_reason      = excluded.verdict_reason,
  evaluator_reasoning = excluded.evaluator_reasoning,
  evaluator_model     = excluded.evaluator_model,
  evaluated_at        = excluded.evaluated_at,
  concepts_extracted  = excluded.concepts_extracted,
  concepts_accepted   = excluded.concepts_accepted,
  status              = excluded.status,
  md_path             = excluded.md_path
`;

const FTS_DELETE_SQL = `DELETE FROM books_fts WHERE rowid = (SELECT rowid FROM books WHERE id = ?)`;
const FTS_INSERT_SQL = `INSERT INTO books_fts (rowid, title_en, author_en, tags, verdict_reason, evaluator_reasoning)
                        SELECT rowid, COALESCE(title_en, title), COALESCE(author_en, author, ''), ?, COALESCE(verdict_reason, ''), COALESCE(evaluator_reasoning, '')
                        FROM books WHERE id = ?`;

/** Сохраняет (или обновляет) книгу + теги + FTS. Атомарно через транзакцию. */
export function upsertBook(meta: BookCatalogMeta, mdPath: string): void {
  const db = openCacheDb();
  const params = {
    id: meta.id,
    sha256: meta.sha256,
    title: meta.title,
    author: meta.author ?? null,
    title_en: meta.titleEn ?? null,
    author_en: meta.authorEn ?? null,
    word_count: meta.wordCount,
    chapter_count: meta.chapterCount,
    original_format: meta.originalFormat,
    source_archive: meta.sourceArchive ?? null,
    domain: meta.domain ?? null,
    quality_score: meta.qualityScore ?? null,
    conceptual_density: meta.conceptualDensity ?? null,
    originality: meta.originality ?? null,
    is_fiction_or_water:
      meta.isFictionOrWater === undefined ? null : meta.isFictionOrWater ? 1 : 0,
    verdict_reason: meta.verdictReason ?? null,
    evaluator_reasoning: meta.evaluatorReasoning ?? null,
    evaluator_model: meta.evaluatorModel ?? null,
    evaluated_at: meta.evaluatedAt ?? null,
    concepts_extracted: meta.conceptsExtracted ?? null,
    concepts_accepted: meta.conceptsAccepted ?? null,
    status: meta.status,
    md_path: mdPath,
  };
  const txn = db.transaction(() => {
    db.prepare(UPSERT_SQL).run(params);
    db.prepare("DELETE FROM book_tags WHERE book_id = ?").run(meta.id);
    if (meta.tags && meta.tags.length > 0) {
      const ins = db.prepare("INSERT OR IGNORE INTO book_tags (book_id, tag) VALUES (?, ?)");
      for (const tag of meta.tags) ins.run(meta.id, tag);
    }
    db.prepare(FTS_DELETE_SQL).run(meta.id);
    db.prepare(FTS_INSERT_SQL).run((meta.tags ?? []).join(" "), meta.id);
  });
  txn();
}

/** Возвращает sha256→id по всему каталогу для дедупликации при импорте. */
export function getKnownSha256s(): Map<string, string> {
  const db = openCacheDb();
  const rows = db.prepare("SELECT id, sha256 FROM books").all() as Array<{ id: string; sha256: string }>;
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.sha256, r.id);
  return out;
}

/** Удаляет книгу из кэша (на диске остаётся -- удаление файлов вызывает caller). */
export function deleteBook(id: string): void {
  const db = openCacheDb();
  const txn = db.transaction(() => {
    db.prepare(FTS_DELETE_SQL).run(id);
    db.prepare("DELETE FROM book_tags WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM books WHERE id = ?").run(id);
  });
  txn();
}

/**
 * Частичное обновление статуса (без перезаписи тегов/FTS).
 *
 * Используется crystallizer'ом во время batch-обработки -- мы не хотим
 * на каждый book-start/done переписывать FTS-индекс и теги. Это атомарный
 * UPDATE одной строки + опциональные счётчики concepts.
 *
 * Если книги нет -- silently no-op (caller уже мог её удалить из UI пока
 * batch ещё ехал). Возвращает true если строка была реально обновлена.
 */
export function setBookStatus(
  id: string,
  status: BookStatus,
  extras?: { conceptsAccepted?: number; conceptsExtracted?: number },
): boolean {
  const db = openCacheDb();
  const fields: string[] = ["status = @status"];
  const params: Record<string, unknown> = { id, status };
  if (typeof extras?.conceptsAccepted === "number") {
    fields.push("concepts_accepted = @concepts_accepted");
    params.concepts_accepted = extras.conceptsAccepted;
  }
  if (typeof extras?.conceptsExtracted === "number") {
    fields.push("concepts_extracted = @concepts_extracted");
    params.concepts_extracted = extras.conceptsExtracted;
  }
  const sql = `UPDATE books SET ${fields.join(", ")} WHERE id = @id`;
  const info = db.prepare(sql).run(params);
  return info.changes > 0;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export interface CatalogQuery {
  /** FTS5 search query. Если задан -- фильтрация через MATCH. */
  search?: string;
  /** Минимальный quality_score (включительно). */
  minQuality?: number;
  /** Максимальный quality_score (включительно). */
  maxQuality?: number;
  /** Если true -- скрыть художественную литературу и "воду". */
  hideFictionOrWater?: boolean;
  /** Фильтр по статусу. Если не задан -- все. */
  statuses?: BookStatus[];
  /** Фильтр по домену (точное совпадение). */
  domain?: string;
  /** Сортировка. По умолчанию quality_score DESC NULLS LAST, затем title. */
  orderBy?: "quality" | "title" | "words" | "evaluated";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

interface QueryResult {
  rows: (BookCatalogMeta & { mdPath: string })[];
  total: number;
}

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
    /* Скрываем известную fiction/water; неоценённые (NULL) показываем. */
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

/** Главный запрос: возвращает список книг + общее число для пагинации. */
export function query(q: CatalogQuery = {}): QueryResult {
  const db = openCacheDb();
  const { sql: whereSql, params: whereParams } = buildWhere(q);
  const orderSql = buildOrderBy(q);
  const limit = Math.max(0, Math.min(q.limit ?? 200, 1000));
  const offset = Math.max(0, q.offset ?? 0);

  let baseFrom = "FROM books";
  let extraJoinParams: unknown[] = [];
  if (q.search && q.search.trim().length > 0) {
    baseFrom = "FROM books JOIN books_fts ON books.rowid = books_fts.rowid";
    extraJoinParams = [];
    /* FTS MATCH через WHERE, не JOIN ON. */
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

  /* Подтягиваем теги одним запросом для всех id. */
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

/** Возвращает книгу по id (включая теги). null если не найдена. */
export function getBookById(id: string): (BookCatalogMeta & { mdPath: string }) | null {
  const db = openCacheDb();
  const row = db.prepare("SELECT * FROM books WHERE id = ?").get(id) as BookRow | undefined;
  if (!row) return null;
  const tags = (db.prepare("SELECT tag FROM book_tags WHERE book_id = ?").all(id) as Array<{ tag: string }>).map((t) => t.tag);
  return rowToMeta(row, tags);
}

/** Возвращает список id всех книг -- для batch-операций. */
export function queryAllIds(filter?: Pick<CatalogQuery, "minQuality" | "hideFictionOrWater" | "statuses" | "domain" | "search">): string[] {
  const result = query({ ...filter, limit: 1000, offset: 0 });
  return result.rows.map((r) => r.id);
}

// ── Rebuild from filesystem ──────────────────────────────────────────────────

/**
 * Пересобирает кэш из всех `book.md` в library/. Используется когда юзер
 * удалил `bibliary-cache.db` или мигрировал библиотеку на другую машину.
 *
 * Идемпотентно: каждая книга через UPSERT, теги переписываются.
 * Не удаляет книги которых нет на диске -- caller вызывает `pruneMissing()`.
 */
export async function rebuildFromFs(): Promise<{ scanned: number; ingested: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let scanned = 0;
  let ingested = 0;
  let skipped = 0;

  const root = await getLibraryRoot();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    errors.push(`rebuildFromFs: cannot read ${root}: ${err instanceof Error ? err.message : String(err)}`);
    return { scanned, ingested, skipped, errors };
  }

  for (const entry of entries) {
    const dir = path.join(root, entry);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const mdPath = path.join(dir, "book.md");
    try {
      const md = await fs.readFile(mdPath, "utf-8");
      scanned += 1;
      const meta = parseFrontmatter(md);
      if (!meta || !meta.id || !meta.sha256) {
        skipped += 1;
        continue;
      }
      /* parseFrontmatter возвращает Partial -- заполняем required полями. */
      const fullMeta: BookCatalogMeta = {
        id: meta.id,
        sha256: meta.sha256,
        title: meta.title ?? entry,
        author: meta.author,
        titleEn: meta.titleEn,
        authorEn: meta.authorEn,
        originalFile: meta.originalFile ?? "",
        originalFormat: (meta.originalFormat ?? "txt") as BookCatalogMeta["originalFormat"],
        sourceArchive: meta.sourceArchive,
        wordCount: meta.wordCount ?? 0,
        chapterCount: meta.chapterCount ?? 0,
        domain: meta.domain,
        tags: meta.tags,
        qualityScore: meta.qualityScore,
        conceptualDensity: meta.conceptualDensity,
        originality: meta.originality,
        isFictionOrWater: meta.isFictionOrWater,
        verdictReason: meta.verdictReason,
        evaluatorModel: meta.evaluatorModel,
        evaluatedAt: meta.evaluatedAt,
        evaluatorReasoning: undefined, /* CoT в .md секции, не в frontmatter -- читать отдельно если нужно */
        conceptsExtracted: meta.conceptsExtracted,
        conceptsAccepted: meta.conceptsAccepted,
        status: (meta.status ?? "imported") as BookStatus,
        warnings: meta.warnings,
      };
      upsertBook(fullMeta, mdPath);
      ingested += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ENOENT")) errors.push(`${entry}: ${msg}`);
      skipped += 1;
    }
  }
  return { scanned, ingested, skipped, errors };
}

/** Удаляет из кэша книги, чьи .md файлы больше не существуют на диске. */
export async function pruneMissing(): Promise<number> {
  const db = openCacheDb();
  const rows = db.prepare("SELECT id, md_path FROM books").all() as Array<{ id: string; md_path: string }>;
  let removed = 0;
  for (const r of rows) {
    try {
      await fs.access(r.md_path);
    } catch {
      deleteBook(r.id);
      removed += 1;
    }
  }
  return removed;
}
