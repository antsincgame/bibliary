/**
 * tests/vectordb-filter.test.ts
 *
 * Pure-function тесты `chromaWhereToLance` — нет I/O, нет LanceDB.
 *
 * Покрытие 7 паттернов которые реально используются в Bibliary:
 *   1. simple equality          { bookId: "abc" }
 *   2. explicit $eq             { bookId: { $eq: "abc" } }
 *   3. $ne                      { domain: { $ne: "fiction" } }
 *   4. $in                      { domain: { $in: ["math", "cs"] } }
 *   5. $or — несколько          { $or: [{ bookId: "x" }, { bookId: "y" }] }
 *   6. $and — несколько         { $and: [...] }
 *   7. nested combinations       { $or: [{ bookId: "x" }, { $and: [...] }] }
 *
 * Плюс — security/validation:
 *   - empty where → null
 *   - field name с инъекцией → throw
 *   - string value со SQL-кавычкой → escape
 *   - unknown operator → throw
 *
 * SQL-output использует BACKTICKS для case-sensitive identifier'ов
 * (DataFusion lowercase'ит unquoted, а `"..."` трактует как string literal).
 * В тестах backtick'и через String.fromCharCode(96) чтобы не конфликтовать
 * с template-literal'ами JS.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { chromaWhereToLance, whereExact, whereAnyOf, whereAllOf } from "../electron/lib/vectordb/filter.ts";

/** Backtick для построения expected SQL strings — нельзя использовать
 * template literals потому что backtick = template delimiter. */
const BT = String.fromCharCode(96);

/** Помощник: завернуть identifier в backticks. */
function id(name: string): string {
  return BT + name + BT;
}

/* ─── happy path ───────────────────────────────────────────────────── */

test("[vectordb-filter] empty / null / undefined → null", () => {
  assert.equal(chromaWhereToLance(null), null);
  assert.equal(chromaWhereToLance(undefined), null);
  assert.equal(chromaWhereToLance({}), null);
});

test("[vectordb-filter] simple equality (shorthand)", () => {
  assert.equal(chromaWhereToLance({ bookId: "abc-123" }), id("bookId") + " = 'abc-123'");
});

test("[vectordb-filter] explicit $eq", () => {
  assert.equal(chromaWhereToLance({ bookId: { $eq: "abc-123" } }), id("bookId") + " = 'abc-123'");
});

test("[vectordb-filter] $ne", () => {
  assert.equal(chromaWhereToLance({ domain: { $ne: "fiction" } }), id("domain") + " != 'fiction'");
});

test("[vectordb-filter] number scalar inline (no quotes)", () => {
  assert.equal(chromaWhereToLance({ chunkIndex: 5 }), id("chunkIndex") + " = 5");
});

test("[vectordb-filter] boolean scalar inline", () => {
  assert.equal(chromaWhereToLance({ isFictionOrWater: true }), id("isFictionOrWater") + " = true");
  assert.equal(chromaWhereToLance({ isFictionOrWater: false }), id("isFictionOrWater") + " = false");
});

test("[vectordb-filter] $gt / $gte / $lt / $lte", () => {
  assert.equal(chromaWhereToLance({ chunkIndex: { $gte: 5 } }), id("chunkIndex") + " >= 5");
  assert.equal(chromaWhereToLance({ chunkIndex: { $lt: 100 } }), id("chunkIndex") + " < 100");
});

test("[vectordb-filter] $in expands to SQL IN", () => {
  assert.equal(
    chromaWhereToLance({ domain: { $in: ["math", "cs"] } }),
    id("domain") + " IN ('math', 'cs')",
  );
});

test("[vectordb-filter] $nin expands to NOT IN", () => {
  assert.equal(
    chromaWhereToLance({ domain: { $nin: ["fiction"] } }),
    id("domain") + " NOT IN ('fiction')",
  );
});

test("[vectordb-filter] $or array of equality conditions", () => {
  assert.equal(
    chromaWhereToLance({ $or: [{ bookId: "x" }, { bookId: "y" }] }),
    "(" + id("bookId") + " = 'x' OR " + id("bookId") + " = 'y')",
  );
});

test("[vectordb-filter] $and array of equality conditions", () => {
  assert.equal(
    chromaWhereToLance({ $and: [{ bookId: "x" }, { domain: "math" }] }),
    "(" + id("bookId") + " = 'x' AND " + id("domain") + " = 'math')",
  );
});

test("[vectordb-filter] multiple top-level keys treated as $and", () => {
  /* `{a, b}` ≡ `$and: [{a},{b}]` per Chroma semantics */
  const sql = chromaWhereToLance({ bookId: "x", domain: "math" });
  /* Order of keys is implementation-defined по Object.keys, тестируем как множество */
  assert.ok(sql !== null);
  assert.ok(sql!.includes(id("bookId") + " = 'x'"));
  assert.ok(sql!.includes(id("domain") + " = 'math'"));
  assert.ok(sql!.includes("AND"));
});

test("[vectordb-filter] nested $or with $and", () => {
  const sql = chromaWhereToLance({
    $or: [
      { bookId: "x" },
      { $and: [{ domain: "math" }, { chunkIndex: { $gt: 0 } }] },
    ],
  });
  assert.equal(
    sql,
    "(" + id("bookId") + " = 'x' OR (" + id("domain") + " = 'math' AND " + id("chunkIndex") + " > 0))",
  );
});

/* ─── escaping ─────────────────────────────────────────────────────── */

test("[vectordb-filter] string with single quote escapes via doubling", () => {
  assert.equal(
    chromaWhereToLance({ bookSourcePath: "/path/O'Brien.epub" }),
    id("bookSourcePath") + " = '/path/O''Brien.epub'",
  );
});

test("[vectordb-filter] string with semicolons / parens does NOT inject", () => {
  /* Semicolon в строке не выходит из quoted literal — escape недостаточен,
   * но parser DataFusion видит литерал целиком как валидную строку. */
  const sql = chromaWhereToLance({ x: "a; DROP TABLE books--" });
  assert.equal(sql, id("x") + " = 'a; DROP TABLE books--'");
});

/* ─── validation / errors ──────────────────────────────────────────── */

test("[vectordb-filter] field name with semicolon → throw", () => {
  assert.throws(
    () => chromaWhereToLance({ "bookId; DROP": "x" }),
    /invalid field name/,
  );
});

test("[vectordb-filter] field name starting with digit → throw", () => {
  assert.throws(
    () => chromaWhereToLance({ "0bad": "x" }),
    /invalid field name/,
  );
});

test("[vectordb-filter] unknown operator → throw", () => {
  assert.throws(
    () => chromaWhereToLance({ field: { $unknown: "x" } }),
    /unsupported operator/,
  );
});

test("[vectordb-filter] empty $or array → throw", () => {
  assert.throws(
    () => chromaWhereToLance({ $or: [] }),
    /non-empty array/,
  );
});

test("[vectordb-filter] $or with non-object element → throw", () => {
  assert.throws(
    () => chromaWhereToLance({ $or: ["x"] as unknown[] as Array<Record<string, unknown>> }),
    /must be objects/,
  );
});

test("[vectordb-filter] non-finite number → throw", () => {
  assert.throws(
    () => chromaWhereToLance({ x: Number.POSITIVE_INFINITY }),
    /non-finite/,
  );
});

test("[vectordb-filter] field equals array (not via $in) → throw", () => {
  assert.throws(
    () => chromaWhereToLance({ tags: ["a", "b"] as unknown as string }),
    /\$in/,
  );
});

/* ─── helper functions ─────────────────────────────────────────────── */

test("[vectordb-filter] whereExact wraps single field", () => {
  assert.deepStrictEqual(whereExact("bookId", "abc"), { bookId: "abc" });
});

test("[vectordb-filter] whereAnyOf single matcher → simple equality", () => {
  assert.deepStrictEqual(
    whereAnyOf([{ field: "bookId", value: "x" }]),
    { bookId: "x" },
  );
});

test("[vectordb-filter] whereAnyOf multi → $or", () => {
  assert.deepStrictEqual(
    whereAnyOf([{ field: "bookId", value: "x" }, { field: "bookId", value: "y" }]),
    { $or: [{ bookId: "x" }, { bookId: "y" }] },
  );
});

test("[vectordb-filter] whereAllOf multi → $and", () => {
  assert.deepStrictEqual(
    whereAllOf([{ field: "bookId", value: "x" }, { field: "domain", value: "math" }]),
    { $and: [{ bookId: "x" }, { domain: "math" }] },
  );
});
