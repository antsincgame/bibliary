/**
 * Solo-mode shim smoke — exercises the SQLite document store, the
 * Appwrite-`Query.*` → SQL translator, and the filesystem storage shim
 * end to end, without Appwrite / HTTP.
 *
 * These are the contract guarantees the 23 repo files depend on when
 * `BIBLIARY_SOLO=1`: a `createDocument` round-trips through
 * `getDocument`, `listDocuments` honours the same `Query.*` filters the
 * Appwrite path does, booleans and arrays survive the trip, and a
 * missing doc throws an Appwrite-shaped 404.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import Database from "better-sqlite3";
import { Query } from "../server/lib/store/query.js";

import type { Config } from "../server/config.ts";
import { bootstrapStoreSchema } from "../server/lib/store/solo-bootstrap.ts";
import { DocumentStore } from "../server/lib/store/sqlite-store.ts";
import { FileStore } from "../server/lib/store/storage-shim.ts";
import { translateQueries } from "../server/lib/store/query-translate.ts";

const DB_ID = "bibliary";

describe("solo: query-translate", () => {
  it("equal with a scalar → single = bind", () => {
    const t = translateQueries([Query.equal("userId", "u1")]);
    assert.equal(t.where, '"userId" = ?');
    assert.deepEqual(t.params, ["u1"]);
  });

  it("equal with an array → IN clause ($in form)", () => {
    const t = translateQueries([Query.equal("status", ["imported", "evaluated"])]);
    assert.equal(t.where, '"status" IN (?, ?)');
    assert.deepEqual(t.params, ["imported", "evaluated"]);
  });

  it("booleans coerce to 0/1 (better-sqlite3 rejects JS booleans)", () => {
    const t = translateQueries([Query.equal("accepted", true)]);
    assert.deepEqual(t.params, [1]);
  });

  it("ordering, limit, offset are extracted", () => {
    const t = translateQueries([
      Query.orderDesc("createdAt"),
      Query.limit(25),
      Query.offset(50),
    ]);
    assert.equal(t.orderBy, '"createdAt" DESC');
    assert.equal(t.limit, 25);
    assert.equal(t.offset, 50);
  });

  it("search → escaped LIKE", () => {
    const t = translateQueries([Query.search("title", "50% off")]);
    assert.match(t.where, /"title" LIKE \? ESCAPE/);
    assert.deepEqual(t.params, ["%50\\% off%"]);
  });

  it("$id meta field maps to the _id column", () => {
    const t = translateQueries([Query.equal("$id", "abc")]);
    assert.equal(t.where, '"_id" = ?');
  });

  it("an unknown Query method throws — never silently drops a filter", () => {
    /* A dropped Query.equal("userId", ...) would leak every user's
     * rows; the translator must fail loud on anything it can't map. */
    const bogus = JSON.stringify({ method: "cursorAfter", values: ["x"] });
    assert.throws(() => translateQueries([bogus]), /unsupported Query method/);
  });
});

describe("solo: DocumentStore CRUD", () => {
  let db: Database.Database;
  let store: DocumentStore;

  before(() => {
    db = new Database(":memory:");
    bootstrapStoreSchema(db);
    store = new DocumentStore(db);
  });

  after(() => {
    db.close();
  });

  it("createDocument → getDocument round-trips the Appwrite envelope", async () => {
    const created = await store.createDocument(DB_ID, "books", "book-1", {
      userId: "u1",
      title: "Topology of Knowledge",
      status: "imported",
      sha256: "abc123",
      tags: ["math", "graph"],
      isFictionOrWater: false,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });
    assert.equal(created.$id, "book-1");
    assert.equal(created.$collectionId, "books");
    assert.ok(created.$createdAt, "stamps $createdAt");
    assert.deepEqual(created.$permissions, []);

    const fetched = await store.getDocument<{
      title: string;
      tags: string[];
      isFictionOrWater: boolean;
    }>(DB_ID, "books", "book-1");
    assert.equal(fetched.title, "Topology of Knowledge");
    /* array attribute survives JSON round-trip */
    assert.deepEqual(fetched.tags, ["math", "graph"]);
    /* boolean attribute comes back as a real boolean, not 0/1 */
    assert.equal(fetched.isFictionOrWater, false);
  });

  it("getDocument on a missing id throws an Appwrite-shaped 404", async () => {
    await assert.rejects(
      () => store.getDocument(DB_ID, "books", "does-not-exist"),
      (err: unknown) => (err as { code?: number }).code === 404,
    );
  });

  it("updateDocument patches only the provided keys", async () => {
    await store.updateDocument(DB_ID, "books", "book-1", { status: "evaluated" });
    const after = await store.getDocument<{ status: string; title: string }>(
      DB_ID,
      "books",
      "book-1",
    );
    assert.equal(after.status, "evaluated");
    /* untouched key preserved */
    assert.equal(after.title, "Topology of Knowledge");
  });

  it("listDocuments honours Query.equal + ordering + total", async () => {
    await store.createDocument(DB_ID, "books", "book-2", {
      userId: "u1",
      title: "Second Book",
      status: "imported",
      sha256: "def456",
      createdAt: "2026-05-14T01:00:00.000Z",
      updatedAt: "2026-05-14T01:00:00.000Z",
    });
    await store.createDocument(DB_ID, "books", "book-3", {
      userId: "u2",
      title: "Other User Book",
      status: "imported",
      sha256: "ghi789",
      createdAt: "2026-05-14T02:00:00.000Z",
      updatedAt: "2026-05-14T02:00:00.000Z",
    });

    const mine = await store.listDocuments(DB_ID, "books", [
      Query.equal("userId", "u1"),
      Query.orderAsc("createdAt"),
    ]);
    assert.equal(mine.total, 2, "total counts only u1's rows");
    assert.equal(mine.documents.length, 2);
    assert.equal(mine.documents[0].$id, "book-1");
    assert.equal(mine.documents[1].$id, "book-2");
  });

  it("listDocuments limit/offset paginate while total stays full", async () => {
    const page = await store.listDocuments(DB_ID, "books", [
      Query.equal("userId", "u1"),
      Query.orderAsc("createdAt"),
      Query.limit(1),
      Query.offset(1),
    ]);
    assert.equal(page.total, 2, "total ignores limit/offset");
    assert.equal(page.documents.length, 1);
    assert.equal(page.documents[0].$id, "book-2");
  });

  it("deleteDocument removes the row; re-delete throws 404", async () => {
    await store.deleteDocument(DB_ID, "books", "book-3");
    await assert.rejects(
      () => store.deleteDocument(DB_ID, "books", "book-3"),
      (err: unknown) => (err as { code?: number }).code === 404,
    );
  });

  it("UNIQUE constraint surfaces as an Appwrite-shaped 409", async () => {
    /* books has user_sha_unique(userId, sha256) — a duplicate must
     * raise 409 so concept/import dedup paths keep working. */
    await assert.rejects(
      () =>
        store.createDocument(DB_ID, "books", "book-dup", {
          userId: "u1",
          title: "Dup",
          status: "imported",
          sha256: "abc123", // same (userId, sha256) as book-1
          createdAt: "2026-05-14T03:00:00.000Z",
          updatedAt: "2026-05-14T03:00:00.000Z",
        }),
      (err: unknown) => (err as { code?: number }).code === 409,
    );
  });
});

describe("solo: FileStore round-trip", () => {
  let db: Database.Database;
  let storage: FileStore;
  let dataDir: string;

  before(() => {
    db = new Database(":memory:");
    bootstrapStoreSchema(db);
    dataDir = mkdtempSync(join(tmpdir(), "bibliary-solo-storage-"));
    storage = new FileStore(db, { BIBLIARY_DATA_DIR: dataDir } as Config);
  });

  after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("createFile → getFile → getFileDownload → deleteFile", async () => {
    const body = 'a\nb\nc\n';
    const file = new File([body], "export.jsonl", { type: "application/x-ndjson" });

    const created = await storage.createFile("dataset-exports", "file-1", file);
    assert.equal(created.$id, "file-1");
    assert.equal(created.name, "export.jsonl");
    assert.equal(created.sizeOriginal, Buffer.byteLength(body));

    const meta = await storage.getFile("dataset-exports", "file-1");
    assert.equal(meta.name, "export.jsonl");

    const bytes = await storage.getFileDownload("dataset-exports", "file-1");
    assert.equal(Buffer.from(bytes).toString("utf-8"), body);

    await storage.deleteFile("dataset-exports", "file-1");
    await assert.rejects(
      () => storage.getFile("dataset-exports", "file-1"),
      (err: unknown) => (err as { code?: number }).code === 404,
    );
  });

  it("getFileDownload on a missing id throws 404", async () => {
    await assert.rejects(
      () => storage.getFileDownload("dataset-exports", "ghost"),
      (err: unknown) => (err as { code?: number }).code === 404,
    );
  });

  it("rejects unsafe path segments", async () => {
    const file = new File(["x"], "x.bin");
    await assert.rejects(
      () => storage.createFile("dataset-exports", "../escape", file),
      /unsafe fileId/,
    );
  });
});
