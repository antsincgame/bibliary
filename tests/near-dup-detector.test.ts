/* Near-duplicate key normalization + tracker behaviour (in-memory cache, no auto-merge). */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  makeNearDupKey,
  findNearDuplicate,
  registerForNearDup,
  unregisterFromNearDup,
  resetNearDupCache,
} from "../electron/lib/library/near-dup-detector.ts";
import { closeCacheDb } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";

function setupTempDb(t: { after: (fn: () => unknown) => void }): void {
  /* Каждый тест получает свою БД, чтобы singleton-кэш не путался. */
  const tempRoot = path.join(os.tmpdir(), `bibliary-neardup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dataDir = path.join(tempRoot, "data");
  const prevDataDir = process.env.BIBLIARY_DATA_DIR;
  const prevLibraryDb = process.env.BIBLIARY_LIBRARY_DB;
  const prevLibraryRoot = process.env.BIBLIARY_LIBRARY_ROOT;
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = path.join(dataDir, "library");
  closeCacheDb();
  _resetLibraryRootCache();
  resetNearDupCache();
  t.after(async () => {
    closeCacheDb();
    _resetLibraryRootCache();
    resetNearDupCache();
    if (prevDataDir === undefined) delete process.env.BIBLIARY_DATA_DIR;
    else process.env.BIBLIARY_DATA_DIR = prevDataDir;
    if (prevLibraryDb === undefined) delete process.env.BIBLIARY_LIBRARY_DB;
    else process.env.BIBLIARY_LIBRARY_DB = prevLibraryDb;
    if (prevLibraryRoot === undefined) delete process.env.BIBLIARY_LIBRARY_ROOT;
    else process.env.BIBLIARY_LIBRARY_ROOT = prevLibraryRoot;
    await rm(tempRoot, { recursive: true, force: true }).catch((err) => console.error("[near-dup-detector/cleanup] rm Error:", err));
  });
}

test("makeNearDupKey: identical title+author+chapters produce identical key", () => {
  const a = makeNearDupKey({ title: "War and Peace", author: "Leo Tolstoy", chapterCount: 365 });
  const b = makeNearDupKey({ title: "War and Peace", author: "Leo Tolstoy", chapterCount: 365 });
  assert.equal(a, b);
  assert.ok(a && a.length > 0);
});

test("makeNearDupKey: punctuation/case/whitespace ignored", () => {
  const a = makeNearDupKey({ title: "War & Peace!", author: "Leo  Tolstoy", chapterCount: 365 });
  const b = makeNearDupKey({ title: "war   peace ", author: "LeoTolstoy", chapterCount: 365 });
  assert.equal(a, b);
});

test("makeNearDupKey: titleEn/authorEn override originals", () => {
  const en = makeNearDupKey({
    title: "Война и мир",
    titleEn: "War and Peace",
    author: "Толстой",
    authorEn: "Tolstoy",
    chapterCount: 365,
  });
  const orig = makeNearDupKey({
    title: "War and Peace",
    author: "Tolstoy",
    chapterCount: 365,
  });
  assert.equal(en, orig);
});

test("makeNearDupKey: returns null for too-short title (avoids false positives)", () => {
  assert.equal(makeNearDupKey({ title: "ab", chapterCount: 1 }), null);
  assert.equal(makeNearDupKey({ title: "", chapterCount: 1 }), null);
  assert.equal(makeNearDupKey({ title: "  ", chapterCount: 1 }), null);
});

test("makeNearDupKey: different chapterCount → different key (different editions)", () => {
  const a = makeNearDupKey({ title: "Same Book", chapterCount: 10 });
  const b = makeNearDupKey({ title: "Same Book", chapterCount: 12 });
  assert.notEqual(a, b);
});

test("findNearDuplicate / registerForNearDup: register then find returns the registered id", (t) => {
  setupTempDb(t);
  const meta = { title: "Unique Test Book", author: "Author X", chapterCount: 7 };
  assert.equal(findNearDuplicate(meta), null);
  registerForNearDup(meta, "abcdef0123456789");
  assert.equal(findNearDuplicate(meta), "abcdef0123456789");
});

test("registerForNearDup: idempotent — second registration of same key keeps first id", (t) => {
  setupTempDb(t);
  const meta = { title: "Stable Book", chapterCount: 3 };
  registerForNearDup(meta, "1111222233334444");
  registerForNearDup(meta, "5555666677778888");
  assert.equal(findNearDuplicate(meta), "1111222233334444");
});

test("findNearDuplicate: null for unregistered or short-title meta", (t) => {
  setupTempDb(t);
  assert.equal(findNearDuplicate({ title: "Untracked", chapterCount: 5 }), null);
  assert.equal(findNearDuplicate({ title: "ab", chapterCount: 1 }), null);
});

test("unregisterFromNearDup: after unregister, the key is no longer found (no stale id)", (t) => {
  setupTempDb(t);
  const meta = { title: "Deleted Book", author: "Ghost", chapterCount: 9 };
  registerForNearDup(meta, "deadbeefdeadbeef");
  assert.equal(findNearDuplicate(meta), "deadbeefdeadbeef");
  unregisterFromNearDup(meta);
  assert.equal(findNearDuplicate(meta), null);
});

test("unregisterFromNearDup: idempotent — calling on missing key is no-op", (t) => {
  setupTempDb(t);
  unregisterFromNearDup({ title: "Never Registered", chapterCount: 1 });
  unregisterFromNearDup({ title: "Never Registered", chapterCount: 1 });
  assert.equal(findNearDuplicate({ title: "Never Registered", chapterCount: 1 }), null);
});
