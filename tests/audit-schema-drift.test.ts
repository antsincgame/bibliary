/**
 * tests/audit-schema-drift.test.ts
 *
 * Snapshot-based drift detector между двумя name-validation regex'ами
 * в разных слоях:
 *
 *   - electron/ipc/validators.ts:CollectionNameSchema   /^[A-Za-z0-9_-]+$/
 *   - electron/lib/vectordb/filter.ts:FIELD_NAME_RE     /^[A-Za-z_][A-Za-z0-9_]*$/
 *
 * Они УМЫШЛЕННО разные:
 *   - CollectionName допускает `-` и leading digit (требование Lance table-name).
 *   - FIELD_NAME — это идентификатор metadata column в SQL-предикате DataFusion;
 *     там минус трактуется как оператор вычитания, а leading digit ломает парсер
 *     даже под backtick-quote.
 *
 * Контракт между ними должен быть осознанным. Если кто-то «исправит» одну,
 * не подумав о другой — этот тест красный до явного апдейта снапшота, что
 * заставляет review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CollectionNameSchema } from "../electron/ipc/validators.ts";
import { chromaWhereToLance } from "../electron/lib/vectordb/filter.ts";

/* ─── snapshot of CollectionName contract ──────────────────────────── */

test("[schema-drift] CollectionName: leading digit IS allowed (Lance table-name freedom)", () => {
  assert.equal(CollectionNameSchema.safeParse("123abc").success, true,
    "drift: CollectionName regex previously allowed leading digit; обновите snapshot если намеренно");
});

test("[schema-drift] CollectionName: leading dash IS allowed", () => {
  assert.equal(CollectionNameSchema.safeParse("-foo").success, true,
    "drift: CollectionName regex previously allowed leading dash");
});

test("[schema-drift] CollectionName: leading underscore IS allowed", () => {
  assert.equal(CollectionNameSchema.safeParse("_foo").success, true);
});

test("[schema-drift] CollectionName: hyphen-in-body IS allowed (отличает от FIELD_NAME)", () => {
  assert.equal(CollectionNameSchema.safeParse("foo-bar").success, true);
});

test("[schema-drift] CollectionName: dot/quote/whitespace/unicode REJECTED", () => {
  for (const bad of ["foo.bar", "foo'bar", "foo\"bar", "foo bar", "кириллица", ""]) {
    assert.equal(CollectionNameSchema.safeParse(bad).success, false,
      `drift: CollectionName previously rejected ${JSON.stringify(bad)} — изменение требует security review`);
  }
});

test("[schema-drift] CollectionName: length boundaries 1..255", () => {
  assert.equal(CollectionNameSchema.safeParse("a").success, true);
  assert.equal(CollectionNameSchema.safeParse("x".repeat(255)).success, true);
  assert.equal(CollectionNameSchema.safeParse("x".repeat(256)).success, false,
    "drift: 255-char limit relaxed");
});

/* ─── snapshot of FIELD_NAME contract (через chromaWhereToLance ч/я) ── */

test("[schema-drift] FIELD_NAME: leading digit MUST be rejected (DataFusion SQL parser quirk)", () => {
  assert.throws(
    () => chromaWhereToLance({ "123abc": "v" }),
    /invalid field name/i,
    "FIELD_NAME drift: leading-digit field name no longer rejected — это сломает SQL предикат",
  );
});

test("[schema-drift] FIELD_NAME: leading dash MUST be rejected", () => {
  assert.throws(
    () => chromaWhereToLance({ "-foo": "v" }),
    /invalid field name/i,
  );
});

test("[schema-drift] FIELD_NAME: hyphen-in-body MUST be rejected (clashes with SQL minus)", () => {
  assert.throws(
    () => chromaWhereToLance({ "foo-bar": "v" }),
    /invalid field name/i,
    "FIELD_NAME drift: hyphen-in-name relaxed — DataFusion парсит `foo-bar` как `foo MINUS bar`",
  );
});

test("[schema-drift] FIELD_NAME: leading underscore IS allowed (valid SQL identifier)", () => {
  const sql = chromaWhereToLance({ "_foo": "v" });
  assert.ok(typeof sql === "string" && sql.includes("_foo"),
    `FIELD_NAME drift: _foo no longer accepted; got ${sql}`);
});

test("[schema-drift] FIELD_NAME: standard letter-start identifier passes", () => {
  const sql = chromaWhereToLance({ bookId: "x" });
  assert.ok(sql && sql.includes("bookId"));
});

test("[schema-drift] FIELD_NAME: dot/space/quote/unicode REJECTED", () => {
  for (const bad of ["foo.bar", "foo bar", "foo'bar", "foo\"bar", "кириллица"]) {
    assert.throws(
      () => chromaWhereToLance({ [bad]: "v" }),
      /invalid field name/i,
      `FIELD_NAME drift: ${JSON.stringify(bad)} no longer rejected`,
    );
  }
});

/* ─── semantic asymmetry contract ──────────────────────────────────── */

test("[schema-drift] semantic asymmetry: hyphen-name is collection-only, NEVER metadata field", () => {
  /* Закрепляем сознательную разницу. Если кто-то расширит FIELD_NAME до
   * hyphen — он должен явно изменить этот тест, объяснив почему DataFusion
   * теперь умеет в quoted-hyphen-names безопасно. */
  assert.equal(CollectionNameSchema.safeParse("foo-bar").success, true,
    "CollectionName allows hyphen — нужно для имён tables вида 'delta-knowledge'");
  assert.throws(
    () => chromaWhereToLance({ "foo-bar": "v" }),
    /invalid field name/i,
    "asymmetry broken: ослабление FIELD_NAME требует security review SQL-инъекций через `-` в backticked identifier",
  );
});

test("[schema-drift] semantic asymmetry: leading-digit name is collection-only", () => {
  assert.equal(CollectionNameSchema.safeParse("2024-archive").success, true);
  assert.throws(
    () => chromaWhereToLance({ "2024field": "v" }),
    /invalid field name/i,
  );
});
