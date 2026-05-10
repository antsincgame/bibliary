/**
 * tests/ipc-library-catalog-handlers.test.ts
 *
 * Unit-тесты для pure validators в library-catalog-ipc.ts.
 *
 * Catalog IPC обслуживает чтение каталога из renderer (рендер сетки книг,
 * раскрытие коллекции, открытие book.md, удаление). Большинство handlers
 * требуют только string bookId — валидируется одной строкой, повторённой
 * ~10 раз. Вынеси в общий validator + покрытие.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateBookIdString,
  validateDeleteBookArgs,
  sanitizeLocale,
} from "../electron/ipc/handlers/library-catalog.handlers.ts";

/* ─── validateBookIdString ────────────────────────────────────────── */

test("[ipc/catalog] validateBookIdString: valid string returned as-is", () => {
  assert.equal(validateBookIdString("abc123"), "abc123");
  assert.equal(validateBookIdString("a"), "a");
});

test("[ipc/catalog] validateBookIdString: empty string → null", () => {
  assert.equal(validateBookIdString(""), null);
});

test("[ipc/catalog] validateBookIdString: non-string → null", () => {
  for (const v of [null, undefined, 42, true, {}, [], () => "x"]) {
    assert.equal(validateBookIdString(v), null, `${JSON.stringify(v)} → null`);
  }
});

/* ─── validateDeleteBookArgs ──────────────────────────────────────── */

test("[ipc/catalog] validateDeleteBookArgs: minimal valid", () => {
  const r = validateDeleteBookArgs({ bookId: "x" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.bookId, "x");
  assert.equal(r.data?.deleteFiles, undefined);
  assert.equal(r.data?.activeCollection, undefined);
});

test("[ipc/catalog] validateDeleteBookArgs: full payload", () => {
  const r = validateDeleteBookArgs({
    bookId: "x",
    deleteFiles: true,
    activeCollection: "my-collection",
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.deleteFiles, true);
  assert.equal(r.data?.activeCollection, "my-collection");
});

test("[ipc/catalog] validateDeleteBookArgs: deleteFiles=false explicitly preserved", () => {
  /* Семантика: если передали false — НЕ удалять файлы (только из БД).
     Default (undefined) трактуется handler'ом как true. */
  const r = validateDeleteBookArgs({ bookId: "x", deleteFiles: false });
  assert.equal(r.data?.deleteFiles, false);
});

test("[ipc/catalog] validateDeleteBookArgs: missing bookId → reason", () => {
  for (const v of [{}, { bookId: "" }, { bookId: 42 }, null, undefined, "string"]) {
    const r = validateDeleteBookArgs(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
    assert.equal(r.reason, "bookId required");
  }
});

test("[ipc/catalog] validateDeleteBookArgs: non-string activeCollection silently dropped", () => {
  const r = validateDeleteBookArgs({ bookId: "x", activeCollection: 42 });
  assert.equal(r.ok, true);
  assert.equal(r.data?.activeCollection, undefined);
});

test("[ipc/catalog] validateDeleteBookArgs: empty activeCollection silently dropped", () => {
  const r = validateDeleteBookArgs({ bookId: "x", activeCollection: "" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.activeCollection, undefined);
});

test("[ipc/catalog] validateDeleteBookArgs: non-boolean deleteFiles silently dropped", () => {
  const r = validateDeleteBookArgs({ bookId: "x", deleteFiles: "yes" });
  assert.equal(r.data?.deleteFiles, undefined);
});

/* ─── sanitizeLocale ─────────────────────────────────────────────── */

test("[ipc/catalog] sanitizeLocale: ru / en accepted", () => {
  assert.equal(sanitizeLocale("ru"), "ru");
  assert.equal(sanitizeLocale("en"), "en");
});

test("[ipc/catalog] sanitizeLocale: anything else → undefined", () => {
  for (const v of ["fr", "RU", "EN", "", null, undefined, 42, {}, []]) {
    assert.equal(sanitizeLocale(v), undefined, `${JSON.stringify(v)} → undefined`);
  }
});
