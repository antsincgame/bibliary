import type Database from "better-sqlite3";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS books (
  id                  TEXT PRIMARY KEY,
  sha256              TEXT UNIQUE NOT NULL,
  -- bibliographic
  title               TEXT NOT NULL,
  author              TEXT,
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
 *   v2 → v3: year, isbn, publisher columns + indexes.
 *   v3 → v4: last_error column for diagnosable failed extraction/evaluation.
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
}
