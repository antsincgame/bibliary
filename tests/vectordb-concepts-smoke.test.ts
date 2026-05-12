/**
 * Phase 10b — sqlite-vec concept ops smoke. Real sqlite-vec in tmpdir.
 * Покрывает insert / find similar / delete / per-user partition.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ENV_SNAPSHOT: Record<string, string | undefined> = {};
let tmpDir = "";

before(async () => {
  ENV_SNAPSHOT["BIBLIARY_VECTORS_DB_PATH"] = process.env["BIBLIARY_VECTORS_DB_PATH"];
  ENV_SNAPSHOT["BIBLIARY_DATA_DIR"] = process.env["BIBLIARY_DATA_DIR"];
  ENV_SNAPSHOT["BIBLIARY_EMBEDDING_DIM"] = process.env["BIBLIARY_EMBEDDING_DIM"];
  ENV_SNAPSHOT["APPWRITE_ENDPOINT"] = process.env["APPWRITE_ENDPOINT"];
  ENV_SNAPSHOT["APPWRITE_PROJECT_ID"] = process.env["APPWRITE_PROJECT_ID"];
  ENV_SNAPSHOT["APPWRITE_API_KEY"] = process.env["APPWRITE_API_KEY"];

  tmpDir = mkdtempSync(path.join(os.tmpdir(), "vec-concepts-"));
  process.env["BIBLIARY_VECTORS_DB_PATH"] = path.join(tmpDir, "vectors.db");
  process.env["BIBLIARY_DATA_DIR"] = tmpDir;
  process.env["BIBLIARY_EMBEDDING_DIM"] = "4"; // tiny dim for tests
  process.env["APPWRITE_ENDPOINT"] = "http://localhost/v1";
  process.env["APPWRITE_PROJECT_ID"] = "test";
  process.env["APPWRITE_API_KEY"] = "test";

  /* Reset cached singleton: if an earlier test (e.g. via transitive
   * import) opened the vector DB with a different dim or path, our
   * env vars above would be ignored. Force fresh init. */
  const { resetVectorDbForTesting } = await import("../server/lib/vectordb/db.ts");
  resetVectorDbForTesting();
});

after(async () => {
  const { closeVectorDb } = await import("../server/lib/vectordb/db.ts");
  closeVectorDb();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  /* Reset DB between tests — drop concepts_vec и пересоздадим. */
  const { getVectorDb } = await import("../server/lib/vectordb/db.ts");
  const { db } = getVectorDb();
  db.exec("DELETE FROM concepts_vec");
});

function unitVec(seed: number[]): Float32Array {
  const v = new Float32Array(4);
  for (let i = 0; i < Math.min(seed.length, 4); i++) v[i] = seed[i];
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm;
  return v;
}

describe("sqlite-vec concepts ops", () => {
  it("insertConceptVector returns auto-increment rowid", async () => {
    const { insertConceptVector } = await import("../server/lib/vectordb/concepts.ts");
    const rowid1 = insertConceptVector({
      userId: "alice",
      bookId: "book-1",
      collectionName: "training-v1",
      embedding: unitVec([1, 0, 0, 0]),
    });
    const rowid2 = insertConceptVector({
      userId: "alice",
      bookId: "book-1",
      collectionName: "training-v1",
      embedding: unitVec([0, 1, 0, 0]),
    });
    assert.ok(rowid1 > 0);
    assert.ok(rowid2 > rowid1);
  });

  it("findSimilarConcepts: nearest first, distance ascending", async () => {
    const { insertConceptVector, findSimilarConcepts } = await import(
      "../server/lib/vectordb/concepts.ts"
    );
    const target = unitVec([1, 0, 0, 0]);
    insertConceptVector({
      userId: "alice",
      bookId: "b1",
      collectionName: "c1",
      embedding: target, // distance 0 to query
    });
    insertConceptVector({
      userId: "alice",
      bookId: "b2",
      collectionName: "c1",
      embedding: unitVec([0.9, 0.1, 0, 0]), // close
    });
    insertConceptVector({
      userId: "alice",
      bookId: "b3",
      collectionName: "c1",
      embedding: unitVec([0, 1, 0, 0]), // far
    });

    const results = findSimilarConcepts({
      userId: "alice",
      collectionName: "c1",
      embedding: target,
      limit: 3,
    });
    assert.equal(results.length, 3);
    /* First result — identical vector → similarity ~ 1, distance ~ 0. */
    assert.ok(results[0].similarity > 0.99);
    assert.ok(results[0].similarity >= results[1].similarity);
    assert.ok(results[1].similarity >= results[2].similarity);
  });

  it("per-user partition: alice's vectors invisible to bob", async () => {
    const { insertConceptVector, findSimilarConcepts } = await import(
      "../server/lib/vectordb/concepts.ts"
    );
    const v = unitVec([1, 0, 0, 0]);
    insertConceptVector({
      userId: "alice",
      bookId: "b1",
      collectionName: "c1",
      embedding: v,
    });
    insertConceptVector({
      userId: "bob",
      bookId: "b2",
      collectionName: "c1",
      embedding: v,
    });

    const aliceResults = findSimilarConcepts({
      userId: "alice",
      collectionName: "c1",
      embedding: v,
      limit: 10,
    });
    const bobResults = findSimilarConcepts({
      userId: "bob",
      collectionName: "c1",
      embedding: v,
      limit: 10,
    });
    assert.equal(aliceResults.length, 1);
    assert.equal(bobResults.length, 1);
    assert.equal(aliceResults[0].bookId, "b1");
    assert.equal(bobResults[0].bookId, "b2");
  });

  it("per-collection partition: collection isolation", async () => {
    const { insertConceptVector, findSimilarConcepts } = await import(
      "../server/lib/vectordb/concepts.ts"
    );
    const v = unitVec([1, 0, 0, 0]);
    insertConceptVector({
      userId: "alice",
      bookId: "b1",
      collectionName: "training-v1",
      embedding: v,
    });
    insertConceptVector({
      userId: "alice",
      bookId: "b2",
      collectionName: "training-v2",
      embedding: v,
    });

    const v1 = findSimilarConcepts({
      userId: "alice",
      collectionName: "training-v1",
      embedding: v,
      limit: 10,
    });
    assert.equal(v1.length, 1);
    assert.equal(v1[0].bookId, "b1");
  });

  it("minSimilarity filter drops far matches", async () => {
    const { insertConceptVector, findSimilarConcepts } = await import(
      "../server/lib/vectordb/concepts.ts"
    );
    insertConceptVector({
      userId: "alice",
      bookId: "b1",
      collectionName: "c1",
      embedding: unitVec([1, 0, 0, 0]),
    });
    insertConceptVector({
      userId: "alice",
      bookId: "b2",
      collectionName: "c1",
      embedding: unitVec([0, 1, 0, 0]), // orthogonal → similarity ~ 0
    });

    const results = findSimilarConcepts({
      userId: "alice",
      collectionName: "c1",
      embedding: unitVec([1, 0, 0, 0]),
      limit: 10,
      minSimilarity: 0.5,
    });
    /* Only the identical vector should survive 0.5 threshold. */
    assert.equal(results.length, 1);
    assert.equal(results[0].bookId, "b1");
  });

  it("deleteConceptVector removes row and decrements count", async () => {
    const { insertConceptVector, deleteConceptVector, findSimilarConcepts } =
      await import("../server/lib/vectordb/concepts.ts");
    const rowid = insertConceptVector({
      userId: "alice",
      bookId: "b1",
      collectionName: "c1",
      embedding: unitVec([1, 0, 0, 0]),
    });
    const deleted = deleteConceptVector(rowid);
    assert.equal(deleted, true);
    const results = findSimilarConcepts({
      userId: "alice",
      collectionName: "c1",
      embedding: unitVec([1, 0, 0, 0]),
      limit: 10,
    });
    assert.equal(results.length, 0);
  });

  it("deleteAllUserConceptVectors burns only that user's vectors", async () => {
    const { insertConceptVector, deleteAllUserConceptVectors, findSimilarConcepts } =
      await import("../server/lib/vectordb/concepts.ts");
    const v = unitVec([1, 0, 0, 0]);
    insertConceptVector({ userId: "alice", bookId: "b1", collectionName: "c1", embedding: v });
    insertConceptVector({ userId: "alice", bookId: "b2", collectionName: "c1", embedding: v });
    insertConceptVector({ userId: "bob", bookId: "b3", collectionName: "c1", embedding: v });

    const deleted = deleteAllUserConceptVectors("alice");
    assert.equal(deleted, 2);

    const bobLeft = findSimilarConcepts({
      userId: "bob",
      collectionName: "c1",
      embedding: v,
      limit: 10,
    });
    assert.equal(bobLeft.length, 1);
    assert.equal(bobLeft[0].bookId, "b3");
  });
});
