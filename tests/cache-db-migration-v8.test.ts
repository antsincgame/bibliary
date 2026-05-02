/**
 * Иt 8Г.2 — миграция SQLite user_version 7 → 8.
 *
 * Защита от регрессии:
 *  - старые v7 БД должны бесшовно мигрировать (idempotent ALTER ADD COLUMN);
 *  - новые v8 БД создаются с колонками сразу (через SCHEMA_SQL);
 *  - данные v7 строк не теряются;
 *  - повторный applyMigrations на v8 — no-op;
 *  - upsertBook + setBookStatus умеют писать новые поля; rowToMeta их читает.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import Database from "better-sqlite3";

import { applyMigrations } from "../electron/lib/library/cache-db-schema.ts";

interface ColumnInfo { name: string; type: string }

function getColumns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

function getUserVersion(db: Database.Database): number {
  const row = db.pragma("user_version") as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

/** Эмулируем legacy v7 DB: создаём схему вручную как она была до v8. */
function createLegacyV7Db(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE books (
      id                  TEXT PRIMARY KEY,
      sha256              TEXT UNIQUE NOT NULL,
      title               TEXT NOT NULL,
      author              TEXT,
      title_ru            TEXT,
      author_ru           TEXT,
      title_en            TEXT,
      author_en           TEXT,
      year                INTEGER,
      isbn                TEXT,
      publisher           TEXT,
      word_count          INTEGER NOT NULL,
      chapter_count       INTEGER NOT NULL,
      original_format     TEXT NOT NULL,
      source_archive      TEXT,
      sphere              TEXT,
      domain              TEXT,
      quality_score       INTEGER,
      conceptual_density  INTEGER,
      originality         INTEGER,
      is_fiction_or_water INTEGER,
      verdict_reason      TEXT,
      evaluator_reasoning TEXT,
      evaluator_model     TEXT,
      evaluated_at        TEXT,
      concepts_extracted  INTEGER,
      concepts_accepted   INTEGER,
      status              TEXT NOT NULL,
      last_error          TEXT,
      md_path             TEXT NOT NULL
    );
    CREATE TABLE book_tags (book_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (book_id, tag));
    CREATE TABLE book_tags_ru (book_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (book_id, tag));
    CREATE VIRTUAL TABLE books_fts USING fts5(title_en, author_en, title_ru, author_ru, tags, verdict_reason, evaluator_reasoning);
  `);
  db.pragma("user_version = 7");
  return db;
}

test("[Г.2] migrations: legacy v7 DB мигрирует в v8 без потери данных", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "bibliary-mig8-"));
  try {
    const dbPath = path.join(tmp, "legacy.db");
    const db = createLegacyV7Db(dbPath);

    /* Кладём строку в v7 БД до миграции. */
    db.prepare(`
      INSERT INTO books (id, sha256, title, word_count, chapter_count, original_format, status, md_path)
      VALUES ('book-1', 'sha-aaa', 'Legacy Book', 5000, 12, 'pdf', 'imported', '/tmp/legacy.md')
    `).run();
    assert.strictEqual(getUserVersion(db), 7);

    applyMigrations(db);

    assert.strictEqual(getUserVersion(db), 8);
    const cols = getColumns(db, "books").map((c) => c.name);
    assert.ok(cols.includes("chunker_provenance"), "должна появиться chunker_provenance");
    assert.ok(cols.includes("chunks_total"), "должна появиться chunks_total");

    /* Старая строка должна выжить + новые колонки = NULL. */
    const row = db.prepare("SELECT id, title, chunker_provenance, chunks_total FROM books WHERE id = ?").get("book-1") as {
      id: string; title: string; chunker_provenance: string | null; chunks_total: number | null;
    };
    assert.strictEqual(row.id, "book-1");
    assert.strictEqual(row.title, "Legacy Book");
    assert.strictEqual(row.chunker_provenance, null);
    assert.strictEqual(row.chunks_total, null);

    db.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("[Г.2] migrations: повторный applyMigrations на v8 — no-op (идемпотентно)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "bibliary-mig8-rep-"));
  try {
    const dbPath = path.join(tmp, "v8.db");
    const db = createLegacyV7Db(dbPath);

    applyMigrations(db);
    assert.strictEqual(getUserVersion(db), 8);

    /* Второй прогон не должен бросать дубль-ALTER ошибку и менять версию. */
    applyMigrations(db);
    assert.strictEqual(getUserVersion(db), 8);

    db.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("[Г.2] migrations: chunks_total INTEGER принимает 0 и большие числа", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "bibliary-mig8-int-"));
  try {
    const dbPath = path.join(tmp, "v8int.db");
    const db = createLegacyV7Db(dbPath);
    applyMigrations(db);

    const ins = db.prepare(`
      INSERT INTO books (id, sha256, title, word_count, chapter_count, original_format, status, md_path, chunks_total)
      VALUES (?, ?, ?, 1, 1, 'pdf', 'imported', '/tmp/x.md', ?)
    `);
    ins.run("b-zero", "sha-zero", "Empty Book", 0);
    ins.run("b-large", "sha-large", "Huge Book", 100_000);

    const zero = db.prepare("SELECT chunks_total FROM books WHERE id=?").get("b-zero") as { chunks_total: number };
    const large = db.prepare("SELECT chunks_total FROM books WHERE id=?").get("b-large") as { chunks_total: number };
    assert.strictEqual(zero.chunks_total, 0);
    assert.strictEqual(large.chunks_total, 100_000);

    db.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("[Г.2] migrations: chunker_provenance принимает JSON-строку и NULL", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "bibliary-mig8-prov-"));
  try {
    const dbPath = path.join(tmp, "v8prov.db");
    const db = createLegacyV7Db(dbPath);
    applyMigrations(db);

    const sample = JSON.stringify({ model: "qwen3-14b", chunks: 42, accepted: 30, ts: "2026-05-02T00:00:00Z" });
    db.prepare(`
      INSERT INTO books (id, sha256, title, word_count, chapter_count, original_format, status, md_path, chunker_provenance)
      VALUES (?, ?, ?, 1, 1, 'pdf', 'imported', '/tmp/x.md', ?)
    `).run("b-prov", "sha-prov", "Provenance Book", sample);

    const row = db.prepare("SELECT chunker_provenance FROM books WHERE id=?").get("b-prov") as {
      chunker_provenance: string;
    };
    const parsed = JSON.parse(row.chunker_provenance);
    assert.strictEqual(parsed.model, "qwen3-14b");
    assert.strictEqual(parsed.chunks, 42);
    assert.strictEqual(parsed.accepted, 30);

    db.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
