import type Database from "better-sqlite3";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS books (
  id                  TEXT PRIMARY KEY,
  sha256              TEXT UNIQUE NOT NULL,
  -- bibliographic
  title               TEXT NOT NULL,
  author              TEXT,
  title_ru            TEXT,
  author_ru           TEXT,
  title_en            TEXT,
  author_en           TEXT,
  year                INTEGER,
  isbn                TEXT,
  publisher           TEXT,
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
  -- concepts_deduped: сколько концептов отбросил concept-level dedup gate
  concepts_deduped    INTEGER,
  -- chunker provenance (Иt 8Г.2): JSON-string {model, chunkBytes, accepted, ts}
  -- chunks_total: общее число semantic chunks отправленных на extraction
  chunker_provenance  TEXT,
  chunks_total        INTEGER,
  -- uniqueness evaluator (idea novelty vs vectordb corpus)
  uniqueness_score        INTEGER,
  uniqueness_novel_count  INTEGER,
  uniqueness_total_ideas  INTEGER,
  uniqueness_evaluated_at TEXT,
  uniqueness_error        TEXT,
  -- lifecycle
  status              TEXT NOT NULL,
  last_error          TEXT,
  md_path             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_tags (
  book_id TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (book_id, tag),
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS book_tags_ru (
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
CREATE INDEX IF NOT EXISTS idx_book_tags_ru_tag ON book_tags_ru(tag);

CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
  title_en, author_en, title_ru, author_ru, tags, verdict_reason, evaluator_reasoning
);
`;

/**
 * Schema-version миграции (PRAGMA user_version).
 *
 *   v0 → v1: первичная схема (выше в SCHEMA_SQL).
 *   v1 → v2: пересоздать books_fts без `content=''`.
 *   v2 → v3: year, isbn, publisher columns + indexes.
 *   v3 → v4: last_error column for diagnosable failed extraction/evaluation.
 *   v4 → v5: sphere column + idx_books_sphere, idx_books_author indexes.
 *   v5 → v6: title_ru, author_ru + rebuild books_fts (RU/EN bibliographic search).
 *   v6 → v7: book_tags_ru + FTS tags index EN+RU keywords.
 *   v7 → v8: chunker_provenance TEXT (JSON) + chunks_total INTEGER (Иt 8Г.2).
 *            chunks_total дополняет concepts_extracted: extracted = «прошли LLM»,
 *            chunks_total = «всего semantic chunks подано в pipeline».
 *            chunker_provenance = JSON со снимком: модель chunker'а, средний
 *            размер chunk'а, дата операции — для дебага и провенанса извлечения.
 *   v9 → v10: uniqueness_* columns + concepts_deduped (uniqueness evaluator).
 */
export function applyMigrations(db: Database.Database): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;

  if (current < 2) {
    db.exec(`
      DROP TABLE IF EXISTS books_fts;
      CREATE VIRTUAL TABLE books_fts USING fts5(
        title_en, author_en, tags, verdict_reason, evaluator_reasoning
      );
    `);
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

  if (current < 3) {
    const cols = db.pragma("table_info(books)") as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("year")) db.exec("ALTER TABLE books ADD COLUMN year INTEGER");
    if (!existing.has("isbn")) db.exec("ALTER TABLE books ADD COLUMN isbn TEXT");
    if (!existing.has("publisher")) db.exec("ALTER TABLE books ADD COLUMN publisher TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_year ON books(year)");
    db.pragma("user_version = 3");
  }

  if (current < 4) {
    const cols = db.pragma("table_info(books)") as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("last_error")) db.exec("ALTER TABLE books ADD COLUMN last_error TEXT");
    db.pragma("user_version = 4");
  }

  if (current < 5) {
    const cols = db.pragma("table_info(books)") as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("sphere")) db.exec("ALTER TABLE books ADD COLUMN sphere TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_sphere ON books(sphere)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_author ON books(author)");
    db.pragma("user_version = 5");
  }

  if (current < 6) {
    const cols = db.pragma("table_info(books)") as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("title_ru")) db.exec("ALTER TABLE books ADD COLUMN title_ru TEXT");
    if (!existing.has("author_ru")) db.exec("ALTER TABLE books ADD COLUMN author_ru TEXT");
    db.exec(`
      DROP TABLE IF EXISTS books_fts;
      CREATE VIRTUAL TABLE books_fts USING fts5(
        title_en, author_en, title_ru, author_ru, tags, verdict_reason, evaluator_reasoning
      );
    `);
    db.exec(`
      INSERT INTO books_fts (rowid, title_en, author_en, title_ru, author_ru, tags, verdict_reason, evaluator_reasoning)
      SELECT b.rowid,
             COALESCE(b.title_en, b.title),
             COALESCE(b.author_en, b.author, ''),
             COALESCE(b.title_ru, b.title),
             COALESCE(b.author_ru, b.author, ''),
             COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM book_tags WHERE book_id = b.id), ''),
             COALESCE(b.verdict_reason, ''),
             COALESCE(b.evaluator_reasoning, '')
        FROM books b;
    `);
    db.pragma("user_version = 6");
  }

  if (current < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_tags_ru (
        book_id TEXT NOT NULL,
        tag     TEXT NOT NULL,
        PRIMARY KEY (book_id, tag),
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_book_tags_ru_tag ON book_tags_ru(tag);
    `);
    db.exec(`
      DROP TABLE IF EXISTS books_fts;
      CREATE VIRTUAL TABLE books_fts USING fts5(
        title_en, author_en, title_ru, author_ru, tags, verdict_reason, evaluator_reasoning
      );
    `);
    db.exec(`
      INSERT INTO books_fts (rowid, title_en, author_en, title_ru, author_ru, tags, verdict_reason, evaluator_reasoning)
      SELECT b.rowid,
             COALESCE(b.title_en, b.title),
             COALESCE(b.author_en, b.author, ''),
             COALESCE(b.title_ru, b.title),
             COALESCE(b.author_ru, b.author, ''),
             TRIM(COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM book_tags WHERE book_id = b.id), '') || ' ' ||
                  COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM book_tags_ru WHERE book_id = b.id), '')),
             COALESCE(b.verdict_reason, ''),
             COALESCE(b.evaluator_reasoning, '')
        FROM books b;
    `);
    db.pragma("user_version = 7");
  }

  if (current < 8) {
    /* Иt 8Г.2: provenance чанкера + общее число chunks. ALTER ADD COLUMN
       идемпотентно через table_info — установка проходит для new DBs (через
       SCHEMA_SQL уже создано) и для legacy DBs (только тогда добавит). */
    const cols = db.pragma("table_info(books)") as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("chunker_provenance")) {
      db.exec("ALTER TABLE books ADD COLUMN chunker_provenance TEXT");
    }
    if (!existing.has("chunks_total")) {
      db.exec("ALTER TABLE books ADD COLUMN chunks_total INTEGER");
    }
    db.pragma("user_version = 8");
  }

  if (current < 9) {
    /* v9 (2026-05): композитный индекс (status, id) для cursor-pagination в
       streamBookIdsByStatus(). Запрос:
         WHERE status IN (...) AND id > ? ORDER BY id ASC LIMIT N
       До v9 query planner использовал idx_books_status (single column),
       сортировка по id шла на полученных rows. На корпусах 10K+ книг это
       O(n*log_n) на каждой страница bootstrap'а. Композитный индекс даёт
       прямой ordered scan — O(log_n + page_size). */
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_status_id ON books(status, id)");
    db.pragma("user_version = 9");
  }

  if (current < 10) {
    /* v10 (2026-05): uniqueness evaluator + concept dedup tracking. ALTER ADD
       COLUMN идемпотентно через table_info — для new DBs SCHEMA_SQL уже создал. */
    const cols = db.pragma("table_info(books)") as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has("concepts_deduped")) {
      db.exec("ALTER TABLE books ADD COLUMN concepts_deduped INTEGER");
    }
    if (!existing.has("uniqueness_score")) {
      db.exec("ALTER TABLE books ADD COLUMN uniqueness_score INTEGER");
    }
    if (!existing.has("uniqueness_novel_count")) {
      db.exec("ALTER TABLE books ADD COLUMN uniqueness_novel_count INTEGER");
    }
    if (!existing.has("uniqueness_total_ideas")) {
      db.exec("ALTER TABLE books ADD COLUMN uniqueness_total_ideas INTEGER");
    }
    if (!existing.has("uniqueness_evaluated_at")) {
      db.exec("ALTER TABLE books ADD COLUMN uniqueness_evaluated_at TEXT");
    }
    if (!existing.has("uniqueness_error")) {
      db.exec("ALTER TABLE books ADD COLUMN uniqueness_error TEXT");
    }
    db.pragma("user_version = 10");
  }
}
