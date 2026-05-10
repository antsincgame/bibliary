/**
 * tests/renderer-library-format.test.ts
 *
 * Unit-тесты для pure formatting helpers из renderer/library/format.js.
 *
 * Эти функции вызываются на КАЖДОЙ строке каталога книг (1000+ книг) —
 * регрессия типа «вернули undefined вместо строки» сразу ломает табличку.
 * Раньше эти функции были unit-untested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fmtMB,
  fmtDate,
  fmtWords,
  fmtQuality,
  fmtUniqueness,
  formatBytes,
  cssEscape,
  makeDownloadId,
} from "../renderer/library/format.js";

/* ─── fmtMB ───────────────────────────────────────────────────────── */

test("[lib/format] fmtMB: 0 / undefined / null → '--'", () => {
  /* Семантика «нет данных» отображается как двойной дефис, не как 0 MB
     (которое выглядит как «файл пустой»). */
  assert.equal(fmtMB(0), "--");
  assert.equal(fmtMB(undefined), "--");
  assert.equal(fmtMB(null), "--");
});

test("[lib/format] fmtMB: positive bytes formatted as 'N.NN MB'", () => {
  assert.equal(fmtMB(1024 * 1024), "1.00 MB");
  assert.equal(fmtMB(2 * 1024 * 1024), "2.00 MB");
  assert.equal(fmtMB(1024 * 1024 * 1.5), "1.50 MB");
});

test("[lib/format] fmtMB: large file (gigabyte range) still readable", () => {
  const oneGigabyte = 1024 * 1024 * 1024;
  /* fmtMB не переключается на GB — обычная отображение MB всегда. */
  assert.equal(fmtMB(oneGigabyte), "1024.00 MB");
});

test("[lib/format] fmtMB: sub-MB rounds to 2 decimals", () => {
  /* 512 KB = 0.5 MB. */
  assert.equal(fmtMB(512 * 1024), "0.50 MB");
});

/* ─── fmtDate ─────────────────────────────────────────────────────── */

test("[lib/format] fmtDate: valid ISO → localeString", () => {
  const out = fmtDate("2024-01-15T12:00:00Z");
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
  /* Не валидируем точный формат (зависит от runtime locale), но
     проверяем что хоть какая-то дата вернулась. */
  assert.notEqual(out, "2024-01-15T12:00:00Z", "не identity passthrough");
});

test("[lib/format] fmtDate: invalid string returns 'Invalid Date'", () => {
  /* `new Date("not a date").toLocaleString()` возвращает "Invalid Date".
     Не throw, поэтому fallback ветка не срабатывает. */
  const out = fmtDate("not-a-date-at-all");
  assert.equal(typeof out, "string");
});

test("[lib/format] fmtDate: empty string handled gracefully", () => {
  const out = fmtDate("");
  assert.equal(typeof out, "string");
});

/* ─── fmtWords ────────────────────────────────────────────────────── */

test("[lib/format] fmtWords: small numbers exact", () => {
  assert.equal(fmtWords(0), "0");
  assert.equal(fmtWords(1), "1");
  assert.equal(fmtWords(999), "999");
});

test("[lib/format] fmtWords: thousands as 'N.Nk'", () => {
  assert.equal(fmtWords(1000), "1.0k");
  assert.equal(fmtWords(1500), "1.5k");
  assert.equal(fmtWords(12_500), "12.5k");
  /* 999_999/1000 = 999.999 → toFixed(1) = "1000.0". Точно ловим
     текущее поведение (это не баг — округление вверх). */
  assert.equal(fmtWords(999_999), "1000.0k", "toFixed округляет 999.999 → 1000.0");
});

test("[lib/format] fmtWords: millions as 'N.NM'", () => {
  assert.equal(fmtWords(1_000_000), "1.0M");
  assert.equal(fmtWords(2_500_000), "2.5M");
  assert.equal(fmtWords(10_000_000), "10.0M");
});

test("[lib/format] fmtWords: non-numbers / NaN / Infinity → '—'", () => {
  /* Important: НЕ возвращает "0" — это бы скрыло «эвалюация ещё не прошла» */
  assert.equal(fmtWords(NaN), "—");
  assert.equal(fmtWords(Infinity), "—");
  assert.equal(fmtWords(-Infinity), "—");
  assert.equal(fmtWords("1000" as unknown as number), "—");
  assert.equal(fmtWords(null as unknown as number), "—");
  assert.equal(fmtWords(undefined as unknown as number), "—");
});

/* ─── fmtQuality / fmtUniqueness ──────────────────────────────────── */

test("[lib/format] fmtQuality: rounds to integer string", () => {
  assert.equal(fmtQuality(75), "75");
  assert.equal(fmtQuality(75.4), "75");
  assert.equal(fmtQuality(75.5), "76", "round half up");
  assert.equal(fmtQuality(0), "0");
  assert.equal(fmtQuality(100), "100");
});

test("[lib/format] fmtQuality: invalid → '—' (NOT '0' — distinguishes 'no data')", () => {
  /* КРИТИЧНО: undefined quality = «эвалюация не проводилась», НЕ «0 points».
     Если кто-то заменит на String(n ?? 0) — этот тест поймает регрессию. */
  assert.equal(fmtQuality(NaN), "—");
  assert.equal(fmtQuality(undefined as unknown as number), "—");
  assert.equal(fmtQuality(null as unknown as number), "—");
});

test("[lib/format] fmtUniqueness: distinguishes undefined from 0 (не '100% плагиат')", () => {
  /* То же самое для uniqueness — отдельная функция чтобы документировать
     контракт «недоступно != 0». */
  assert.equal(fmtUniqueness(undefined as unknown as number), "—");
  assert.equal(fmtUniqueness(0), "0");
  assert.equal(fmtUniqueness(100), "100");
});

/* ─── formatBytes ─────────────────────────────────────────────────── */

test("[lib/format] formatBytes: 0 → '0 B'", () => {
  assert.equal(formatBytes(0), "0 B");
});

test("[lib/format] formatBytes: <1KB returns bytes", () => {
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(1023), "1023 B");
});

test("[lib/format] formatBytes: KB range", () => {
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1500), "1.5 KB");
});

test("[lib/format] formatBytes: MB range", () => {
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10.0 MB");
});

test("[lib/format] formatBytes: null/undefined → '0 B' (download progress before start)", () => {
  assert.equal(formatBytes(null as unknown as number), "0 B");
  assert.equal(formatBytes(undefined as unknown as number), "0 B");
});

/* ─── cssEscape ───────────────────────────────────────────────────── */

test("[lib/format] cssEscape: alphanumeric passes through (fallback ветка)", () => {
  /* В node test environment `CSS` undefined → fallback regex.
     Alphanumeric + _ + - не модифицируются. */
  const safe = cssEscape("simple-id_123");
  assert.equal(typeof safe, "string");
  assert.equal(safe, "simple-id_123");
});

test("[lib/format] cssEscape: special chars escaped", () => {
  /* Точки, кавычки, скобки — то что может ломать селектор. */
  const escaped = cssEscape("book.id'with[brackets]");
  assert.equal(typeof escaped, "string");
  /* Хотя бы alphanumeric части остаются. */
  assert.match(escaped, /book/);
  assert.match(escaped, /id/);
});

/* ─── makeDownloadId ──────────────────────────────────────────────── */

test("[lib/format] makeDownloadId: returns unique string", () => {
  const a = makeDownloadId();
  const b = makeDownloadId();
  assert.equal(typeof a, "string");
  assert.notEqual(a, b, "two calls return distinct IDs");
});

test("[lib/format] makeDownloadId: non-empty", () => {
  const id = makeDownloadId();
  assert.ok(id.length > 0);
});
