/**
 * tests/audit-validators-rejection.test.ts
 *
 * Pure-unit покрытие IPC-validators (electron/ipc/validators.ts). До этого
 * теста никто не проверял, что zod-схемы реально отбрасывают malware-payload.
 * Регрессия (например, забыли .min(), сделали refine optional, или regex
 * стал слишком разрешающим) проходила бы тихо до production.
 *
 * Тесты намеренно жёсткие: для каждой схемы есть и accept-positive, и
 * reject-negative, и проверка имени поля в .issues[0].path для parseOrThrow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  CollectionNameSchema,
  AbsoluteFilePathSchema,
  AbsoluteFilePathArraySchema,
  LibraryImportFilePathsSchema,
  parseOrThrow,
} from "../electron/ipc/validators.ts";

/* ─── CollectionNameSchema ─────────────────────────────────────────── */

test("[validators] CollectionName accepts valid identifiers", () => {
  for (const name of [
    "foo",
    "abc123",
    "with-dash",
    "with_underscore",
    "MixedCASE",
    "a",                /* min length 1 */
    "x".repeat(255),    /* max length */
    "X-Y_z-A_b",
    "123-numeric-start", /* leading digit допустим (отличие от FIELD_NAME) */
  ]) {
    const r = CollectionNameSchema.safeParse(name);
    assert.equal(r.success, true, `must accept: ${JSON.stringify(name)}`);
  }
});

test("[validators] CollectionName rejects empty / too long / invalid chars / non-string", () => {
  const cases: Array<[unknown, RegExp | null]> = [
    ["", /required/i],
    ["x".repeat(256), /too long/i],
    ["with space", /\[A-Za-z0-9_-\]/],
    ["with.dot", /\[A-Za-z0-9_-\]/],
    ["with/slash", /\[A-Za-z0-9_-\]/],
    ["with\\backslash", /\[A-Za-z0-9_-\]/],
    ["with'quote", /\[A-Za-z0-9_-\]/],
    ["with\"dquote", /\[A-Za-z0-9_-\]/],
    ["with;semicolon", /\[A-Za-z0-9_-\]/],
    ["with\u0000nul", /\[A-Za-z0-9_-\]/],
    ["юникод", /\[A-Za-z0-9_-\]/],
    ["sql'; DROP TABLE--", /\[A-Za-z0-9_-\]/],
    [123, null],
    [null, null],
    [undefined, null],
    [{}, null],
  ];
  for (const [v, msg] of cases) {
    const r = CollectionNameSchema.safeParse(v);
    assert.equal(r.success, false, `must reject: ${JSON.stringify(v)}`);
    if (msg && r.success === false) {
      const issueMsgs = r.error.issues.map((i) => i.message).join("|");
      assert.match(issueMsgs, msg, `error must mention ${msg} for ${JSON.stringify(v)}`);
    }
  }
});

/* ─── AbsoluteFilePathSchema ───────────────────────────────────────── */

test("[validators] AbsoluteFilePath accepts valid absolute paths (POSIX + Windows)", () => {
  for (const p of [
    "/tmp/file.txt",
    "/usr/local/bin/x",
    "C:\\Users\\file.txt",
    "C:/Users/file.txt",
    "D:\\",
    "/" + "x".repeat(4000),  /* под лимитом 4096 */
  ]) {
    const r = AbsoluteFilePathSchema.safeParse(p);
    assert.equal(r.success, true, `must accept: ${p}`);
  }
});

test("[validators] AbsoluteFilePath rejects relative / traversal / NUL / oversized / non-string", () => {
  const cases: Array<[unknown, RegExp | null]> = [
    ["", /required/i],
    ["x".repeat(4097), /too long/i],
    ["relative/path.txt", /must be absolute/i],
    ["./relative.txt", /must be absolute/i],
    ["../escape.txt", /must be absolute/i],
    ["/legit/../escape.txt", /traversal/i],
    ["/legit/path/with/..", /traversal/i],
    ["/has\u0000nul", /NUL/i],
    [123, null],
    [null, null],
    [{}, null],
  ];
  for (const [v, msg] of cases) {
    const r = AbsoluteFilePathSchema.safeParse(v);
    assert.equal(r.success, false, `must reject: ${JSON.stringify(v)}`);
    if (msg && r.success === false) {
      const issueMsgs = r.error.issues.map((i) => i.message).join("|");
      assert.match(issueMsgs, msg);
    }
  }
});

/* ─── AbsoluteFilePathArraySchema (probe-files cap=1000) ───────────── */

test("[validators] AbsoluteFilePathArray rejects > 1000 paths", () => {
  const arr1000 = Array.from({ length: 1000 }, (_, i) => `/tmp/f${i}`);
  assert.equal(AbsoluteFilePathArraySchema.safeParse(arr1000).success, true);

  const arr1001 = Array.from({ length: 1001 }, (_, i) => `/tmp/f${i}`);
  const r = AbsoluteFilePathArraySchema.safeParse(arr1001);
  assert.equal(r.success, false);
  if (r.success === false) {
    const issueMsgs = r.error.issues.map((i) => i.message).join("|");
    assert.match(issueMsgs, /max 1000/i);
  }
});

test("[validators] AbsoluteFilePathArray: invalid path inside batch fails the whole batch + reports index", () => {
  const arr = ["/tmp/ok1.txt", "../traversal", "/tmp/ok2.txt"];
  const r = AbsoluteFilePathArraySchema.safeParse(arr);
  assert.equal(r.success, false);
  /* path[0] должен быть индексом плохого элемента (1) — диагностика для caller. */
  if (r.success === false) {
    const indices = r.error.issues.map((i) => i.path[0]);
    assert.ok(indices.includes(1),
      `expected error at index 1, got paths=${JSON.stringify(r.error.issues.map((i) => i.path))}`);
  }
});

/* ─── LibraryImportFilePathsSchema (cap=5000) ──────────────────────── */

test("[validators] LibraryImportFilePaths rejects > 5000 paths", () => {
  const arr5000 = Array.from({ length: 5000 }, (_, i) => `/tmp/b${i}`);
  assert.equal(LibraryImportFilePathsSchema.safeParse(arr5000).success, true);

  const arr5001 = Array.from({ length: 5001 }, (_, i) => `/tmp/b${i}`);
  const r = LibraryImportFilePathsSchema.safeParse(arr5001);
  assert.equal(r.success, false);
  if (r.success === false) {
    const issueMsgs = r.error.issues.map((i) => i.message).join("|");
    assert.match(issueMsgs, /max 5000/i);
  }
});

/* ─── parseOrThrow ─────────────────────────────────────────────────── */

test("[validators] parseOrThrow returns parsed value on success", () => {
  const v = parseOrThrow(CollectionNameSchema, "valid-name", "collection");
  assert.equal(v, "valid-name");
});

test("[validators] parseOrThrow throws Error('invalid <argName>: <path>: <msg>') on failure", () => {
  /* Top-level scalar reject: path = [] → "value" */
  assert.throws(
    () => parseOrThrow(CollectionNameSchema, "with space", "collection"),
    (err) => err instanceof Error && /^invalid collection: value:/.test(err.message),
  );
  assert.throws(
    () => parseOrThrow(AbsoluteFilePathSchema, "../traversal", "filePath"),
    (err) => err instanceof Error && /^invalid filePath:/.test(err.message) && /absolute/i.test(err.message),
  );
});

test("[validators] parseOrThrow: nested object error exposes JSON path", () => {
  const Schema = z.object({ inner: z.object({ name: CollectionNameSchema }) });
  assert.throws(
    () => parseOrThrow(Schema, { inner: { name: "with space" } }, "args"),
    (err) => err instanceof Error && /^invalid args: inner\.name:/.test(err.message),
  );
});

test("[validators] parseOrThrow: default argName is 'args'", () => {
  assert.throws(
    () => parseOrThrow(CollectionNameSchema, ""),
    (err) => err instanceof Error && /^invalid args:/.test(err.message),
  );
});
