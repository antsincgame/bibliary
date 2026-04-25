import { openCacheDb } from "./cache-db-connection.js";
import type { BookCatalogMeta, BookStatus } from "./types.js";

const UPSERT_SQL = `
INSERT INTO books (
  id, sha256, title, author, title_en, author_en, year, isbn, publisher,
  word_count, chapter_count, original_format, source_archive,
  domain, quality_score, conceptual_density, originality, is_fiction_or_water,
  verdict_reason, evaluator_reasoning, evaluator_model, evaluated_at,
  concepts_extracted, concepts_accepted, status, last_error, md_path
) VALUES (
  @id, @sha256, @title, @author, @title_en, @author_en, @year, @isbn, @publisher,
  @word_count, @chapter_count, @original_format, @source_archive,
  @domain, @quality_score, @conceptual_density, @originality, @is_fiction_or_water,
  @verdict_reason, @evaluator_reasoning, @evaluator_model, @evaluated_at,
  @concepts_extracted, @concepts_accepted, @status, @last_error, @md_path
)
ON CONFLICT(id) DO UPDATE SET
  sha256              = excluded.sha256,
  title               = excluded.title,
  author              = excluded.author,
  title_en            = excluded.title_en,
  author_en           = excluded.author_en,
  year                = excluded.year,
  isbn                = excluded.isbn,
  publisher           = excluded.publisher,
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
  last_error          = excluded.last_error,
  md_path             = excluded.md_path
`;

const FTS_DELETE_SQL = `DELETE FROM books_fts WHERE rowid = (SELECT rowid FROM books WHERE id = ?)`;
const FTS_INSERT_SQL = `INSERT INTO books_fts (rowid, title_en, author_en, tags, verdict_reason, evaluator_reasoning)
                        SELECT rowid, COALESCE(title_en, title), COALESCE(author_en, author, ''), ?, COALESCE(verdict_reason, ''), COALESCE(evaluator_reasoning, '')
                        FROM books WHERE id = ?`;

export function upsertBook(meta: BookCatalogMeta, mdPath: string): void {
  const db = openCacheDb();
  const params = {
    id: meta.id,
    sha256: meta.sha256,
    title: meta.title,
    author: meta.author ?? null,
    title_en: meta.titleEn ?? null,
    author_en: meta.authorEn ?? null,
    year: meta.year ?? null,
    isbn: meta.isbn ?? null,
    publisher: meta.publisher ?? null,
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
    last_error: meta.lastError ?? null,
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

export function getKnownSha256s(): Map<string, string> {
  const db = openCacheDb();
  const rows = db.prepare("SELECT id, sha256 FROM books").all() as Array<{ id: string; sha256: string }>;
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.sha256, r.id);
  return out;
}

export function deleteBook(id: string): void {
  const db = openCacheDb();
  const txn = db.transaction(() => {
    db.prepare(FTS_DELETE_SQL).run(id);
    db.prepare("DELETE FROM book_tags WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM books WHERE id = ?").run(id);
  });
  txn();
}

export function setBookStatus(
  id: string,
  status: BookStatus,
  extras?: { conceptsAccepted?: number; conceptsExtracted?: number; lastError?: string | null },
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
  if (extras && "lastError" in extras) {
    fields.push("last_error = @last_error");
    params.last_error = extras.lastError ?? null;
  }
  const sql = `UPDATE books SET ${fields.join(", ")} WHERE id = @id`;
  const info = db.prepare(sql).run(params);
  return info.changes > 0;
}
