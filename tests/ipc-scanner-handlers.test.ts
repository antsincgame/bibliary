/**
 * tests/ipc-scanner-handlers.test.ts
 *
 * Unit-тесты для scanner.ipc.ts payload validators.
 *
 * Зод-валидация (AbsoluteFilePathSchema, CollectionNameSchema) уже
 * unit-tested. Здесь — pre-shape проверка и chunkerOptions sanitization,
 * которые раньше жили inline без отдельного покрытия.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeChunkerOptions,
  validateStartIngestShape,
  validateStartFolderBundleShape,
  validateIngestId,
} from "../electron/ipc/handlers/scanner.handlers.ts";

/* ─── sanitizeChunkerOptions ──────────────────────────────────────── */

test("[ipc/scanner] sanitizeChunkerOptions: valid full options", () => {
  const r = sanitizeChunkerOptions({ targetChars: 1000, maxChars: 2000, minChars: 500 });
  assert.deepEqual(r, { targetChars: 1000, maxChars: 2000, minChars: 500 });
});

test("[ipc/scanner] sanitizeChunkerOptions: partial options preserved", () => {
  const r = sanitizeChunkerOptions({ targetChars: 1000 });
  assert.deepEqual(r, { targetChars: 1000 });
});

test("[ipc/scanner] sanitizeChunkerOptions: empty object → undefined (use defaults)", () => {
  /* Семантика: empty object = «caller не задал ничего» = «используй defaults». */
  assert.equal(sanitizeChunkerOptions({}), undefined);
});

test("[ipc/scanner] sanitizeChunkerOptions: invalid values dropped (mix)", () => {
  const r = sanitizeChunkerOptions({
    targetChars: 1000,
    maxChars: -100, /* negative → dropped */
    minChars: 1.5, /* fractional → dropped */
  });
  assert.deepEqual(r, { targetChars: 1000 });
});

test("[ipc/scanner] sanitizeChunkerOptions: all invalid → undefined", () => {
  const r = sanitizeChunkerOptions({
    targetChars: 0,
    maxChars: -1,
    minChars: "500", /* string → dropped */
  });
  assert.equal(r, undefined);
});

test("[ipc/scanner] sanitizeChunkerOptions: non-object input → undefined", () => {
  for (const v of [null, undefined, "string", 42, []]) {
    assert.equal(sanitizeChunkerOptions(v), undefined, `${JSON.stringify(v)} → undefined`);
  }
});

/* ─── validateStartIngestShape ────────────────────────────────────── */

test("[ipc/scanner] validateStartIngestShape: minimal valid", () => {
  const r = validateStartIngestShape({ filePath: "/path/book.pdf", collection: "default" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.filePath, "/path/book.pdf");
  assert.equal(r.data?.collection, "default");
  assert.equal(r.data?.chunkerOptions, undefined);
  assert.equal(r.data?.ocrOverride, undefined);
});

test("[ipc/scanner] validateStartIngestShape: full valid payload", () => {
  const r = validateStartIngestShape({
    filePath: "/p",
    collection: "c",
    chunkerOptions: { targetChars: 800 },
    ocrOverride: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data?.chunkerOptions, { targetChars: 800 });
  assert.equal(r.data?.ocrOverride, true);
});

test("[ipc/scanner] validateStartIngestShape: missing filePath → reason", () => {
  const r = validateStartIngestShape({ collection: "default" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "filePath required");
});

test("[ipc/scanner] validateStartIngestShape: missing collection → reason", () => {
  const r = validateStartIngestShape({ filePath: "/p" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "collection required");
});

test("[ipc/scanner] validateStartIngestShape: empty strings rejected", () => {
  const r1 = validateStartIngestShape({ filePath: "", collection: "c" });
  assert.equal(r1.ok, false);
  const r2 = validateStartIngestShape({ filePath: "/p", collection: "" });
  assert.equal(r2.ok, false);
});

test("[ipc/scanner] validateStartIngestShape: non-object rejected", () => {
  /* [] typeof === "object" → проходит first gate, но без filePath → 'filePath required'.
     Это ОК: главное что ok=false, конкретный reason проверяет, что валидация дошла. */
  for (const v of [null, undefined, "string", 42]) {
    const r = validateStartIngestShape(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
    assert.equal(r.reason, "args required");
  }
  /* Edge: пустой массив. */
  const rArray = validateStartIngestShape([]);
  assert.equal(rArray.ok, false, "[] rejected");
});

test("[ipc/scanner] validateStartIngestShape: invalid chunkerOptions silently dropped", () => {
  /* Bad chunkerOptions не должно завалить весь импорт — caller получит
     undefined и worker возьмёт defaults. */
  const r = validateStartIngestShape({
    filePath: "/p",
    collection: "c",
    chunkerOptions: { targetChars: -1, maxChars: "bad" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.chunkerOptions, undefined);
});

test("[ipc/scanner] validateStartIngestShape: non-boolean ocrOverride dropped", () => {
  const r = validateStartIngestShape({
    filePath: "/p",
    collection: "c",
    ocrOverride: "yes",
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.ocrOverride, undefined);
});

/* ─── validateStartFolderBundleShape ─────────────────────────────── */

test("[ipc/scanner] validateStartFolderBundleShape: valid args", () => {
  const r = validateStartFolderBundleShape({ folderPath: "/dir", collection: "c" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.folderPath, "/dir");
  assert.equal(r.data?.collection, "c");
});

test("[ipc/scanner] validateStartFolderBundleShape: any missing field → reject", () => {
  for (const v of [
    {},
    { folderPath: "/dir" },
    { collection: "c" },
    { folderPath: "", collection: "c" },
    { folderPath: "/dir", collection: "" },
    { folderPath: 42, collection: "c" },
    null,
    undefined,
  ]) {
    const r = validateStartFolderBundleShape(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
    assert.match(r.reason ?? "", /folderPath и collection обязательны/);
  }
});

/* ─── validateIngestId ────────────────────────────────────────────── */

test("[ipc/scanner] validateIngestId: valid string returned", () => {
  assert.equal(validateIngestId("uuid-123"), "uuid-123");
});

test("[ipc/scanner] validateIngestId: invalid → null", () => {
  for (const v of ["", null, undefined, 42, {}]) {
    assert.equal(validateIngestId(v), null);
  }
});
