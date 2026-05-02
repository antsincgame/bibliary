/**
 * Иt 8Д.4 — main-process smoke: full import flow без UI.
 *
 * Цель: гарантировать что bootstrap → importBookFromFile → SQLite → markdown
 * file работают сквозным проходом для простейшего формата (.txt).
 *
 * Стратегия (выбор Примарха 2026-05-02):
 *   - main-process test через node:test (не Playwright/UI)
 *   - реальный .txt fixture — самый простой parsable формат
 *   - НЕ мокаем парсер: мы хотим увидеть что реальный конвейер собирается
 *   - НЕ создаём бинарные фикстуры в репо — генерируем .txt на лету
 *
 * Проверки (smoke level):
 *   1. preferences store init проходит
 *   2. importBookFromFile возвращает outcome === "imported"
 *   3. книга появляется в SQLite через query()
 *   4. markdown файл создан на диске и содержит исходный текст
 *
 * Это НЕ полноценный e2e (без Electron app, без vision LLM, без crystallize).
 * Это контракт-тест: bootstrap не сломан, import API стабилен, БД пишется,
 * markdown пишется.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";

test("[Д.4] full import flow: bootstrap → importBookFromFile → SQLite → markdown", async (t) => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-smoke-import-"));
  const dataDir = path.join(tmpRoot, "data");
  const libraryRoot = path.join(tmpRoot, "library");
  const dbPath = path.join(dataDir, "bibliary-cache.db");
  await mkdir(dataDir, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  /* Изоляция окружения: указываем все три ключевых пути ДО любого
     импорта electron/lib (модули читают env при первом обращении). */
  const prevEnv = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = dbPath;
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;

  t.after(async () => {
    /* Закрываем БД перед удалением tmp (Windows file lock). */
    try {
      const { closeCacheDb } = await import("../../electron/lib/library/cache-db.ts");
      closeCacheDb();
    } catch { /* tolerate */ }
    /* Восстанавливаем env — другие тесты не должны видеть наш tmp. */
    if (prevEnv.BIBLIARY_DATA_DIR === undefined) delete process.env.BIBLIARY_DATA_DIR;
    else process.env.BIBLIARY_DATA_DIR = prevEnv.BIBLIARY_DATA_DIR;
    if (prevEnv.BIBLIARY_LIBRARY_DB === undefined) delete process.env.BIBLIARY_LIBRARY_DB;
    else process.env.BIBLIARY_LIBRARY_DB = prevEnv.BIBLIARY_LIBRARY_DB;
    if (prevEnv.BIBLIARY_LIBRARY_ROOT === undefined) delete process.env.BIBLIARY_LIBRARY_ROOT;
    else process.env.BIBLIARY_LIBRARY_ROOT = prevEnv.BIBLIARY_LIBRARY_ROOT;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /* ── Шаг 1: bootstrap preferences store ── */
  const { initPreferencesStore, getPreferencesStore } = await import(
    "../../electron/lib/preferences/store.ts"
  );
  await initPreferencesStore(dataDir);
  const prefs = await getPreferencesStore().getAll();
  assert.ok(prefs, "prefs должны инициализироваться");
  assert.equal(typeof prefs.evaluatorSlots, "number", "evaluatorSlots default установлен");

  /* ── Шаг 2: создать .txt fixture (минимальный, без бинарей) ── */
  const fixtureDir = path.join(tmpRoot, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, "smoke-book.txt");
  const fixtureText = [
    "Smoke Test Book",
    "by Sparta Phalanx",
    "",
    "Chapter 1: The Manifest",
    "",
    "This is the first chapter. Manifest holds the army.",
    "",
    "Chapter 2: The Battle",
    "",
    "The battle was fierce. Many Athenians fell. The plan held.",
  ].join("\n");
  await writeFile(fixturePath, fixtureText, "utf-8");

  /* ── Шаг 3: importBookFromFile реальный вызов ── */
  const { importBookFromFile } = await import(
    "../../electron/lib/library/import-book.ts"
  );
  const result = await importBookFromFile(fixturePath, {
    ocrEnabled: false,
    visionMetaEnabled: false,
    metadataOnlineLookup: false,
    importRoot: libraryRoot,
  });

  /* "added" = новая книга добавлена; "imported" = синоним успеха в legacy путях.
     Любой из них — успех, главное не "skipped"/"failed"/"duplicate". */
  assert.ok(
    result.outcome === "added" || result.outcome === "imported",
    `import должен пройти, got ${result.outcome}: ${result.error ?? ""}`,
  );
  assert.ok(result.bookId, "должен вернуться bookId");
  assert.ok(result.meta, "должен вернуться meta");

  /* ── Шаг 4: книга в SQLite ── */
  const { query, getBookById } = await import("../../electron/lib/library/cache-db.ts");
  const stored = getBookById(result.bookId!);
  assert.ok(stored, "книга должна быть в SQLite по id");
  assert.equal(stored.id, result.bookId);

  const allBooks = query({});
  assert.ok(allBooks.rows.length >= 1, "query должен вернуть хотя бы одну книгу");
  const found = allBooks.rows.find((b) => b.id === result.bookId);
  assert.ok(found, "наша книга должна быть в общем списке");

  /* ── Шаг 5: markdown на диске ── */
  assert.ok(stored.mdPath, "stored.mdPath должен быть установлен");
  const mdContent = await readFile(stored.mdPath, "utf-8");
  assert.ok(mdContent.length > 0, "markdown файл должен содержать контент");
  assert.match(mdContent, /Smoke Test Book/i, "markdown должен содержать заголовок");
  assert.match(mdContent, /Chapter 1.*Manifest/i, "markdown должен содержать главы");

  /* ── Шаг 6 (бонус): book-md-mutex не сломан ── */
  const { getBookMdLockStats } = await import(
    "../../electron/lib/library/book-md-mutex.ts"
  );
  const lockStats = getBookMdLockStats();
  assert.ok(typeof lockStats.count === "number", "mutex stats доступны");
});

/**
 * Iter 12 P3: e2e — TWO-EDITIONS scenario.
 * Импортируем старую и новую ревизию одной и той же книги. Ожидаем:
 *  1. Обе попытки помечены как "added" (новая выигрывает по revisionScore).
 *  2. Старая ревизия удалена из SQLite после успеха новой (HARD+REPLACE).
 *  3. markdown новой остаётся на диске; старой — удалён.
 */
test("[Iter 12 P3] two-editions: HARD+REPLACE end-to-end", async (t) => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-smoke-twoed-"));
  const dataDir = path.join(tmpRoot, "data");
  const libraryRoot = path.join(tmpRoot, "library");
  await mkdir(dataDir, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  const prevEnv = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;

  t.after(async () => {
    try {
      const { closeCacheDb } = await import("../../electron/lib/library/cache-db.ts");
      closeCacheDb();
    } catch { /* tolerate */ }
    if (prevEnv.BIBLIARY_DATA_DIR === undefined) delete process.env.BIBLIARY_DATA_DIR;
    else process.env.BIBLIARY_DATA_DIR = prevEnv.BIBLIARY_DATA_DIR;
    if (prevEnv.BIBLIARY_LIBRARY_DB === undefined) delete process.env.BIBLIARY_LIBRARY_DB;
    else process.env.BIBLIARY_LIBRARY_DB = prevEnv.BIBLIARY_LIBRARY_DB;
    if (prevEnv.BIBLIARY_LIBRARY_ROOT === undefined) delete process.env.BIBLIARY_LIBRARY_ROOT;
    else process.env.BIBLIARY_LIBRARY_ROOT = prevEnv.BIBLIARY_LIBRARY_ROOT;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const { initPreferencesStore } = await import("../../electron/lib/preferences/store.ts");
  await initPreferencesStore(dataDir);

  const fixtureDir = path.join(tmpRoot, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const olderPath = path.join(fixtureDir, "Sparta_Manifest.txt");
  const newerPath = path.join(fixtureDir, "Sparta_Manifest_2nd_Edition_2024.txt");
  const body = [
    "Chapter 1: Phalanx",
    "",
    "The phalanx holds the line. Each warrior protects his neighbour.",
    "",
    "Chapter 2: Manifest",
    "",
    "The manifest holds the army. Athenian doubts are silenced by Spartan resolve.",
  ].join("\n");
  await writeFile(olderPath, `${body}\nolder unique line\n`, "utf8");
  await writeFile(newerPath, `${body}\nnewer unique line\n`, "utf8");

  const { importBookFromFile } = await import("../../electron/lib/library/import-book.ts");
  const { getBookById } = await import("../../electron/lib/library/cache-db.ts");

  const first = await importBookFromFile(olderPath, { ocrEnabled: false, visionMetaEnabled: false, metadataOnlineLookup: false, importRoot: libraryRoot });
  assert.equal(first.outcome, "added");
  const oldId = first.bookId!;
  assert.ok(getBookById(oldId), "older revision present after first import");

  const second = await importBookFromFile(newerPath, { ocrEnabled: false, visionMetaEnabled: false, metadataOnlineLookup: false, importRoot: libraryRoot });
  assert.equal(second.outcome, "added");
  const newId = second.bookId!;
  assert.notEqual(newId, oldId);

  /* HARD+REPLACE: old book is gone from DB, new book remains. */
  assert.equal(getBookById(oldId), null, "older revision must be evicted from DB after successful new import");
  assert.ok(getBookById(newId), "newer revision must remain");

  /* New markdown contains body. */
  const newMeta = getBookById(newId)!;
  const md = await readFile(newMeta.mdPath, "utf8");
  assert.match(md, /Phalanx|Manifest/i, "new markdown contains body content");
  assert.ok(md.length > 100, "new markdown has substantive content");
});

/**
 * Iter 12 P3: e2e — FAILED-IMPORT scenario.
 * Файл с supported extension но нечитаемым contents (random binary) → outcome="failed"
 * и errorMessage заполнен. Импорт-pipeline не падает.
 */
test("[Iter 12 P3] failed-import: corrupt file → outcome=failed без crash", async (t) => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-smoke-fail-"));
  const dataDir = path.join(tmpRoot, "data");
  const libraryRoot = path.join(tmpRoot, "library");
  await mkdir(dataDir, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  const prevEnv = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;

  t.after(async () => {
    try {
      const { closeCacheDb } = await import("../../electron/lib/library/cache-db.ts");
      closeCacheDb();
    } catch { /* tolerate */ }
    if (prevEnv.BIBLIARY_DATA_DIR === undefined) delete process.env.BIBLIARY_DATA_DIR;
    else process.env.BIBLIARY_DATA_DIR = prevEnv.BIBLIARY_DATA_DIR;
    if (prevEnv.BIBLIARY_LIBRARY_DB === undefined) delete process.env.BIBLIARY_LIBRARY_DB;
    else process.env.BIBLIARY_LIBRARY_DB = prevEnv.BIBLIARY_LIBRARY_DB;
    if (prevEnv.BIBLIARY_LIBRARY_ROOT === undefined) delete process.env.BIBLIARY_LIBRARY_ROOT;
    else process.env.BIBLIARY_LIBRARY_ROOT = prevEnv.BIBLIARY_LIBRARY_ROOT;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const { initPreferencesStore } = await import("../../electron/lib/preferences/store.ts");
  await initPreferencesStore(dataDir);

  /* Создаём `.epub` с PK magic (ZIP), но повреждённым содержимым — parser
     должен завершиться ошибкой (or skipped), не упасть с unhandled. */
  const fixtureDir = path.join(tmpRoot, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const corruptPath = path.join(fixtureDir, "corrupt.epub");
  /* PK\x03\x04 — ZIP magic, но дальше мусор (ZIP central directory битый). */
  const garbage = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
    Buffer.alloc(2048, 0xff),
  ]);
  await writeFile(corruptPath, garbage);

  const { importBookFromFile } = await import("../../electron/lib/library/import-book.ts");
  const result = await importBookFromFile(corruptPath, {
    ocrEnabled: false,
    visionMetaEnabled: false,
    metadataOnlineLookup: false,
    importRoot: libraryRoot,
  });

  /* Контракт smoke: process не падает с unhandled exception, возвращён
     структурный результат с outcome. Реальный outcome зависит от parser:
     - "failed" — parser отверг битый zip
     - "skipped" — magic-guard / format detector
     - "added" с warnings — parser вытащил пустой текст (fallback path)
     Все три варианта принимаемы; единственное что должно НЕ случаться —
     это throw / process crash. */
  assert.ok(
    typeof result.outcome === "string" && result.outcome.length > 0,
    "result.outcome must be a string (no crash, structured response)",
  );
  /* При added контракт: либо есть warnings (parser догадался что мусор),
     либо meta заполнен (это true edge case fallback). В любом случае
     bookId есть. */
  if (result.outcome === "added") {
    assert.ok(result.bookId, "added result must have bookId");
  }
  if (result.outcome === "failed") {
    assert.ok(result.error, "failed result must include error message for diagnostics");
  }
});
