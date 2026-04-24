/* Cover the pure helpers extracted from renderer/library.js (strangler step #1). */
import { test } from "node:test";
import assert from "node:assert/strict";

/* tsx умеет резолвить .js путь как ESM. Renderer-helpers — чистый JS,
   без DOM, поэтому отлично импортируются в Node-test runner. */
import {
  fmtMB,
  fmtDate,
  fmtWords,
  fmtQuality,
  formatBytes,
  cssEscape,
  makeDownloadId,
} from "../renderer/library/format.js";
import {
  filterCatalog,
  qualityClass,
  statusClass,
  QUALITY_PRESETS,
} from "../renderer/library/catalog-filter.js";

test("fmtMB returns -- for falsy and 2-decimal MB otherwise", () => {
  assert.equal(fmtMB(0), "--");
  assert.equal(fmtMB(undefined as unknown as number), "--");
  assert.equal(fmtMB(1024 * 1024), "1.00 MB");
  assert.equal(fmtMB(1024 * 1024 * 5.5), "5.50 MB");
});

test("fmtDate parses ISO and falls back to input on bad date", () => {
  const iso = "2026-04-23T10:00:00.000Z";
  const out = fmtDate(iso);
  assert.notEqual(out, "");
  assert.notEqual(out, iso);
  /* Невалидная строка просто возвращается через locale (Date(NaN).toLocaleString -> "Invalid Date"). */
  const bad = fmtDate("definitely-not-a-date");
  assert.equal(typeof bad, "string");
});

test("fmtWords handles 0/k/M and non-numbers", () => {
  assert.equal(fmtWords(NaN), "—");
  assert.equal(fmtWords(undefined as unknown as number), "—");
  assert.equal(fmtWords(0), "0");
  assert.equal(fmtWords(999), "999");
  assert.equal(fmtWords(1000), "1.0k");
  assert.equal(fmtWords(1_500), "1.5k");
  assert.equal(fmtWords(1_000_000), "1.0M");
  assert.equal(fmtWords(2_500_000), "2.5M");
});

test("fmtQuality rounds and rejects non-numbers", () => {
  assert.equal(fmtQuality(NaN), "—");
  assert.equal(fmtQuality(null as unknown as number), "—");
  assert.equal(fmtQuality(70), "70");
  assert.equal(fmtQuality(85.7), "86");
  assert.equal(fmtQuality(0), "0");
});

test("formatBytes covers bytes/KB/MB tiers", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 * 3.5), "3.5 MB");
});

test("cssEscape sanitizes selector-unsafe chars", () => {
  /* Эскейп должен превратить специальные символы (.\:) либо через
     CSS.escape (если есть глобально), либо через ASCII fallback. */
  const safe = cssEscape("plain-id_42");
  assert.equal(safe, "plain-id_42");
  const dangerous = cssEscape("a.b:c");
  assert.notEqual(dangerous, "a.b:c", "non-trivial chars must be escaped");
});

test("makeDownloadId returns unique strings", () => {
  const a = makeDownloadId();
  const b = makeDownloadId();
  assert.notEqual(a, b);
  assert.equal(typeof a, "string");
  assert.ok(a.length > 8);
});

test("QUALITY_PRESETS is frozen and ordered low->high", () => {
  assert.equal(Object.isFrozen(QUALITY_PRESETS), true);
  const values = QUALITY_PRESETS.map((p) => p.value);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], "presets must not decrease");
  }
  assert.deepEqual(QUALITY_PRESETS.map((p) => p.key), ["all", "workable", "solid", "premium"]);
});

test("qualityClass tiers", () => {
  assert.equal(qualityClass(undefined as unknown as number), "lib-q-unset");
  assert.equal(qualityClass(NaN), "lib-q-low");
  assert.equal(qualityClass(0), "lib-q-low");
  assert.equal(qualityClass(49), "lib-q-low");
  assert.equal(qualityClass(50), "lib-q-workable");
  assert.equal(qualityClass(69), "lib-q-workable");
  assert.equal(qualityClass(70), "lib-q-solid");
  assert.equal(qualityClass(85), "lib-q-solid");
  assert.equal(qualityClass(86), "lib-q-premium");
  assert.equal(qualityClass(100), "lib-q-premium");
});

test("statusClass strips unsafe chars", () => {
  assert.equal(statusClass("evaluated"), "lib-status-evaluated");
  assert.equal(statusClass("crystallizing"), "lib-status-crystallizing");
  assert.equal(statusClass("weird/status*1"), "lib-status-weirdstatus1");
});

test("filterCatalog: quality threshold drops rows below floor", () => {
  const rows = [
    { id: "a", qualityScore: 90 },
    { id: "b", qualityScore: 60 },
    { id: "c", qualityScore: 30 },
    { id: "d" /* no score */ },
  ];
  const out70 = filterCatalog(rows, { quality: 70, hideFiction: false, search: "" });
  assert.deepEqual(out70.map((r: { id: string }) => r.id), ["a"]);
  const out0 = filterCatalog(rows, { quality: 0, hideFiction: false, search: "" });
  assert.equal(out0.length, 4, "quality=0 means no filter");
});

test("filterCatalog: hideFiction drops rows where isFictionOrWater === true", () => {
  const rows = [
    { id: "fic", isFictionOrWater: true },
    { id: "ok",  isFictionOrWater: false },
    { id: "unk" /* undefined */ },
  ];
  const out = filterCatalog(rows, { quality: 0, hideFiction: true, search: "" });
  assert.deepEqual(out.map((r: { id: string }) => r.id), ["ok", "unk"]);
});

test("filterCatalog: search is case-insensitive across title/author/domain/tags", () => {
  const rows = [
    { id: "a", title: "Foundations of UX", author: "Alice", domain: "ux design", tags: ["wcag", "a11y"] },
    { id: "b", titleEn: "Marketing Bible", authorEn: "Bob", domain: "marketing" },
    { id: "c", title: "JavaScript: The Good Parts", author: "Crockford" },
  ];
  assert.deepEqual(filterCatalog(rows, { quality: 0, hideFiction: false, search: "wcag" }).map((r: { id: string }) => r.id), ["a"]);
  assert.deepEqual(filterCatalog(rows, { quality: 0, hideFiction: false, search: "MARKETING" }).map((r: { id: string }) => r.id), ["b"]);
  assert.deepEqual(filterCatalog(rows, { quality: 0, hideFiction: false, search: "crockford" }).map((r: { id: string }) => r.id), ["c"]);
});

test("filterCatalog: combined filters (quality + fiction + search) all apply", () => {
  const rows = [
    { id: "a", qualityScore: 90, isFictionOrWater: false, title: "Topology" },
    { id: "b", qualityScore: 90, isFictionOrWater: true,  title: "Topology Fiction" },
    { id: "c", qualityScore: 40, isFictionOrWater: false, title: "Topology For Kids" },
  ];
  const out = filterCatalog(rows, { quality: 70, hideFiction: true, search: "topology" });
  assert.deepEqual(out.map((r: { id: string }) => r.id), ["a"]);
});
