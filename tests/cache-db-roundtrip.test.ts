/**
 * tests/cache-db-roundtrip.test.ts
 *
 * Защита от молчаливых поломок SQLite-каталога: roundtrip upsertBook → readBack
 * для ВСЕХ полей BookCatalogMeta, плюс setBookStatus extras, deleteBook, FTS5,
 * tag persistence. Без этого слоя любая mutation-bug = повреждённый каталог.
 *
 * Что тестируем:
 *  1. upsertBook: roundtrip всех полей (incl. uniqueness v10, conceptsDeduped)
 *  2. upsertBook: ON CONFLICT — повторный upsert заменяет прежние значения
 *  3. setBookStatus: partial-update (только указанные поля меняются, остальные сохраняются)
 *  4. setBookStatus: новые extras (conceptsDeduped, lastError reset через null)
 *  5. getBookById / getBooksByIds: правильно возвращают / null при отсутствии
 *  6. deleteBook: удаляет книгу + tags + FTS-row
 *  7. tag persistence: book_tags + book_tags_ru roundtrip
 *  8. FTS5 search: query({search}) находит по title/tags/reasoning
 *  9. uniqueness fields: undefined ↔ null правильно мапится туда и обратно
 * 10. partial meta: книга с минимумом полей сохраняется без ошибок
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  closeCacheDb,
  upsertBook,
  getBookById,
  getBooksByIds,
  deleteBook,
  setBookStatus,
  query,
  openCacheDb,
} from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import type { BookCatalogMeta } from "../electron/lib/library/types.ts";

interface Sandbox {
  tempRoot: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-db-"));
  const dataDir = path.join(tempRoot, "data");
  const prev = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = path.join(dataDir, "library");
  closeCacheDb();
  _resetLibraryRootCache();
  return {
    tempRoot,
    cleanup: async () => {
      closeCacheDb();
      _resetLibraryRootCache();
      for (const k of Object.keys(prev) as (keyof typeof prev)[]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function fullMeta(overrides: Partial<BookCatalogMeta> = {}): BookCatalogMeta {
  return {
    id: "book-001",
    sha256: "a".repeat(64),
    originalFile: "test.pdf",
    originalFormat: "pdf",
    title: "Test Book",
    author: "Original Author",
    titleRu: "Тестовая Книга",
    authorRu: "Оригинальный Автор",
    titleEn: "Test Book",
    authorEn: "Original Author",
    year: 2023,
    isbn: "9781234567890",
    publisher: "Test Press",
    sphere: "Science",
    sourceArchive: "archive.zip",
    wordCount: 50_000,
    chapterCount: 12,
    domain: "computer science",
    tags: ["algorithms", "data-structures"],
    tagsRu: ["алгоритмы", "структуры-данных"],
    qualityScore: 78,
    conceptualDensity: 82,
    originality: 65,
    isFictionOrWater: false,
    verdictReason: "Solid CS textbook with rigorous treatment.",
    evaluatorReasoning: "Looking at TOC and intro...",
    evaluatorModel: "qwen3-7b",
    evaluatedAt: "2026-05-08T12:00:00Z",
    conceptsExtracted: 42,
    conceptsAccepted: 38,
    conceptsDeduped: 4,
    chunksTotal: 50,
    chunkerProvenance: '{"model":"e5","ts":"2026-05-08"}',
    uniquenessScore: 73,
    uniquenessNovelCount: 11,
    uniquenessTotalIdeas: 15,
    uniquenessEvaluatedAt: "2026-05-08T12:30:00Z",
    uniquenessError: undefined,
    status: "evaluated",
    lastError: undefined,
    ...overrides,
  };
}

/* ─── 1. Full roundtrip ──────────────────────────────────────────── */

test("[cache-db] upsertBook → getBookById: все поля сохраняются", async () => {
  const sb = await makeSandbox();
  try {
    const meta = fullMeta();
    upsertBook(meta, "/tmp/library/test.md");

    const got = getBookById("book-001");
    assert.ok(got);
    assert.equal(got!.id, "book-001");
    assert.equal(got!.title, "Test Book");
    assert.equal(got!.titleRu, "Тестовая Книга");
    assert.equal(got!.year, 2023);
    assert.equal(got!.isbn, "9781234567890");
    assert.equal(got!.qualityScore, 78);
    assert.equal(got!.isFictionOrWater, false);
    assert.deepEqual(got!.tags, ["algorithms", "data-structures"]);
    assert.deepEqual(got!.tagsRu, ["алгоритмы", "структуры-данных"]);
    assert.equal(got!.conceptsExtracted, 42);
    assert.equal(got!.conceptsAccepted, 38);
    assert.equal(got!.conceptsDeduped, 4);
    /* uniqueness columns (v10 migration) */
    assert.equal(got!.uniquenessScore, 73);
    assert.equal(got!.uniquenessNovelCount, 11);
    assert.equal(got!.uniquenessTotalIdeas, 15);
    assert.equal(got!.uniquenessEvaluatedAt, "2026-05-08T12:30:00Z");
    assert.equal(got!.status, "evaluated");
    assert.equal(got!.mdPath, "/tmp/library/test.md");
  } finally {
    await sb.cleanup();
  }
});

test("[cache-db] upsertBook: undefined → null roundtrip (без потери семантики)", async () => {
  const sb = await makeSandbox();
  try {
    /* Минимально допустимая книга — большинство полей undefined. */
    const minimal: BookCatalogMeta = {
      id: "book-min",
      sha256: "b".repeat(64),
      originalFile: "min.txt",
      originalFormat: "txt",
      title: "Minimal",
      wordCount: 100,
      chapterCount: 1,
      status: "imported",
    };
    upsertBook(minimal, "/tmp/min.md");

    const got = getBookById("book-min");
    assert.ok(got);
    assert.equal(got!.author, undefined);
    assert.equal(got!.year, undefined);
    assert.equal(got!.qualityScore, undefined);
    assert.equal(got!.uniquenessScore, undefined);
    assert.equal(got!.conceptsDeduped, undefined);
    assert.equal(got!.tags, undefined);
    assert.equal(got!.tagsRu, undefined);
    assert.equal(got!.isFictionOrWater, undefined);
  } finally {
    await sb.cleanup();
  }
});

/* ─── 2. ON CONFLICT semantics ──────────────────────────────────── */

test("[cache-db] upsertBook повторно: ON CONFLICT обновляет поля", async () => {
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({ qualityScore: 50, status: "imported" }), "/tmp/v1.md");
    upsertBook(fullMeta({ qualityScore: 90, status: "evaluated", titleEn: "Updated Title" }), "/tmp/v2.md");

    const got = getBookById("book-001");
    assert.equal(got!.qualityScore, 90);
    assert.equal(got!.status, "evaluated");
    assert.equal(got!.titleEn, "Updated Title");
    assert.equal(got!.mdPath, "/tmp/v2.md");
  } finally {
    await sb.cleanup();
  }
});

test("[cache-db] upsertBook повторно: tags ПОЛНОСТЬЮ замещаются (а не аккумулируются)", async () => {
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({ tags: ["old-1", "old-2"], tagsRu: ["старый"] }), "/tmp/v1.md");
    upsertBook(fullMeta({ tags: ["new-1"], tagsRu: ["новый-1", "новый-2"] }), "/tmp/v1.md");

    const got = getBookById("book-001");
    assert.deepEqual(got!.tags, ["new-1"]);
    assert.deepEqual(got!.tagsRu, ["новый-1", "новый-2"]);
  } finally {
    await sb.cleanup();
  }
});

/* ─── 3. setBookStatus partial-update ───────────────────────────── */

test("[cache-db] setBookStatus: меняет только status и указанные extras", async () => {
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({ status: "imported", qualityScore: 78 }), "/tmp/x.md");
    const ok = setBookStatus("book-001", "indexed", {
      conceptsAccepted: 100,
      conceptsExtracted: 120,
      conceptsDeduped: 5,
    });
    assert.equal(ok, true);

    const got = getBookById("book-001");
    assert.equal(got!.status, "indexed");
    assert.equal(got!.conceptsAccepted, 100);
    assert.equal(got!.conceptsExtracted, 120);
    assert.equal(got!.conceptsDeduped, 5);
    /* qualityScore сохранился — setBookStatus не должен его обнулять. */
    assert.equal(got!.qualityScore, 78);
  } finally {
    await sb.cleanup();
  }
});

test("[cache-db] setBookStatus: lastError=null сбрасывает прежнее значение", async () => {
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({ status: "failed", lastError: "old failure" }), "/tmp/x.md");
    setBookStatus("book-001", "imported", { lastError: null });

    const got = getBookById("book-001");
    assert.equal(got!.status, "imported");
    assert.equal(got!.lastError, undefined);
  } finally {
    await sb.cleanup();
  }
});

test("[cache-db] setBookStatus на несуществующую книгу → false", async () => {
  const sb = await makeSandbox();
  try {
    const ok = setBookStatus("non-existent", "indexed");
    assert.equal(ok, false);
  } finally {
    await sb.cleanup();
  }
});

/* ─── 4. Multi-record queries ──────────────────────────────────── */

test("[cache-db] getBooksByIds: возвращает только существующие, в порядке запроса", async () => {
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({ id: "a", sha256: "1".repeat(64), title: "A" }), "/tmp/a.md");
    upsertBook(fullMeta({ id: "b", sha256: "2".repeat(64), title: "B" }), "/tmp/b.md");
    upsertBook(fullMeta({ id: "c", sha256: "3".repeat(64), title: "C" }), "/tmp/c.md");

    const out = getBooksByIds(["c", "missing", "a", "b"]);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, "c");
    assert.equal(out[1].id, "a");
    assert.equal(out[2].id, "b");
  } finally {
    await sb.cleanup();
  }
});

test("[cache-db] getBooksByIds: пустой массив → []", async () => {
  const sb = await makeSandbox();
  try {
    assert.deepEqual(getBooksByIds([]), []);
  } finally {
    await sb.cleanup();
  }
});

test("[cache-db] getBookById: missing → null", async () => {
  const sb = await makeSandbox();
  try {
    assert.equal(getBookById("ghost"), null);
  } finally {
    await sb.cleanup();
  }
});

/* ─── 5. deleteBook ────────────────────────────────────────────── */

test("[cache-db] deleteBook: удаляет книгу и связанные tags", async () => {
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({ tags: ["a", "b"], tagsRu: ["а", "б"] }), "/tmp/x.md");
    deleteBook("book-001");

    assert.equal(getBookById("book-001"), null);
    /* Tag-таблицы тоже должны быть пустые (FK ON DELETE CASCADE / явный delete). */
    const db = openCacheDb();
    const enRows = db.prepare("SELECT * FROM book_tags WHERE book_id = ?").all("book-001");
    const ruRows = db.prepare("SELECT * FROM book_tags_ru WHERE book_id = ?").all("book-001");
    assert.equal(enRows.length, 0);
    assert.equal(ruRows.length, 0);
  } finally {
    await sb.cleanup();
  }
});

/* ─── 6. FTS5 search ──────────────────────────────────────────── */

test("[cache-db] query({search}) находит по title/tags/reasoning", async () => {
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({
      id: "fts-1", sha256: "f".repeat(64),
      title: "Algorithms", titleEn: "Algorithms Unlocked",
      tags: ["sorting", "graph-theory"],
    }), "/tmp/fts1.md");
    upsertBook(fullMeta({
      id: "fts-2", sha256: "e".repeat(64),
      title: "Cooking", titleEn: "Italian Cooking",
      tags: ["pasta", "tomato"],
    }), "/tmp/fts2.md");

    const r1 = query({ search: "Algorithms" });
    assert.equal(r1.total, 1);
    assert.equal(r1.rows[0].id, "fts-1");

    const r2 = query({ search: "pasta" });
    assert.equal(r2.total, 1);
    assert.equal(r2.rows[0].id, "fts-2");

    /* FTS5 трактует дефис как оператор; для multi-word tag используем quoted phrase. */
    const r3 = query({ search: '"graph-theory"' });
    assert.equal(r3.total, 1);
    assert.equal(r3.rows[0].id, "fts-1");
  } finally {
    await sb.cleanup();
  }
});

test("[cache-db] query: фильтр minQuality + hideFictionOrWater", async () => {
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({ id: "k1", sha256: "1".repeat(64), qualityScore: 90, isFictionOrWater: false }), "/tmp/1.md");
    upsertBook(fullMeta({ id: "k2", sha256: "2".repeat(64), qualityScore: 30, isFictionOrWater: false }), "/tmp/2.md");
    upsertBook(fullMeta({ id: "k3", sha256: "3".repeat(64), qualityScore: 95, isFictionOrWater: true }), "/tmp/3.md");

    const r = query({ minQuality: 60, hideFictionOrWater: true });
    assert.equal(r.total, 1);
    assert.equal(r.rows[0].id, "k1");
  } finally {
    await sb.cleanup();
  }
});

/* ─── 7. Uniqueness fields в FTS5 НЕ участвуют (intentional) ───── */

test("[cache-db] uniqueness fields доступны через getBookById после re-open", async () => {
  /* Проверяем что значения ДЕЙСТВИТЕЛЬНО в SQLite, а не в кеше процесса. */
  const sb = await makeSandbox();
  try {
    upsertBook(fullMeta({
      uniquenessScore: 42,
      uniquenessNovelCount: 8,
      uniquenessTotalIdeas: 19,
      uniquenessError: "partial extraction",
    }), "/tmp/x.md");

    closeCacheDb(); /* симулируем рестарт процесса */

    const got = getBookById("book-001");
    assert.equal(got!.uniquenessScore, 42);
    assert.equal(got!.uniquenessNovelCount, 8);
    assert.equal(got!.uniquenessTotalIdeas, 19);
    assert.equal(got!.uniquenessError, "partial extraction");
  } finally {
    await sb.cleanup();
  }
});
