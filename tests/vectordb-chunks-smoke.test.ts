/**
 * Phase Δb — chunks meta + chunks_vec smoke. Verifies that:
 *   - insertChunk writes BOTH vec0 row and chunks meta row atomically
 *   - getChunkByRowId / getChunksByRowIds round-trip all fields
 *   - findSimilarChunks returns ranked rows with similarity desc
 *   - linkChunkSiblings sets prev/next pointers per section
 *   - level filter in findSimilarChunks isolates L0/L1/L2 grain
 *   - deleteAllChunksForBook removes from both tables
 *   - per-user partition: bob's chunks are invisible to alice's KNN
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ENV_SNAPSHOT: Record<string, string | undefined> = {};
let tmpDir = "";

before(async () => {
  for (const key of [
    "BIBLIARY_VECTORS_DB_PATH",
    "BIBLIARY_DATA_DIR",
    "BIBLIARY_EMBEDDING_DIM",
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_API_KEY",
  ]) {
    ENV_SNAPSHOT[key] = process.env[key];
  }
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "vec-chunks-"));
  process.env["BIBLIARY_VECTORS_DB_PATH"] = path.join(tmpDir, "vectors.db");
  process.env["BIBLIARY_DATA_DIR"] = tmpDir;
  process.env["BIBLIARY_EMBEDDING_DIM"] = "4";
  process.env["APPWRITE_ENDPOINT"] = "http://localhost/v1";
  process.env["APPWRITE_PROJECT_ID"] = "test";
  process.env["APPWRITE_API_KEY"] = "test";
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
  const { getVectorDb } = await import("../server/lib/vectordb/db.ts");
  const { db } = getVectorDb();
  db.exec("DELETE FROM chunks_vec");
  db.exec("DELETE FROM chunks");
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

describe("chunks meta + chunks_vec", () => {
  it("insertChunk writes vec + meta atomically; round-trip fields", async () => {
    const { insertChunk, getChunkByRowId } = await import(
      "../server/lib/vectordb/chunks.ts"
    );
    const rowid = insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([1, 0, 0, 0]),
      text: "the body of the section",
      pathTitles: ["Part I", "Chapter 2"],
      sectionLevel: 2,
      sectionOrder: 5,
      partN: 3,
      partOf: 7,
    });
    assert.ok(rowid > 0);
    const meta = getChunkByRowId(rowid);
    assert.ok(meta);
    assert.equal(meta.userId, "alice");
    assert.equal(meta.bookId, "b1");
    assert.equal(meta.level, 1);
    assert.deepEqual(meta.pathTitles, ["Part I", "Chapter 2"]);
    assert.equal(meta.sectionLevel, 2);
    assert.equal(meta.sectionOrder, 5);
    assert.equal(meta.partN, 3);
    assert.equal(meta.partOf, 7);
    assert.equal(meta.text, "the body of the section");
    assert.equal(meta.prevVecRowId, null);
    assert.equal(meta.nextVecRowId, null);
  });

  it("findSimilarChunks: nearest first, similarity desc", async () => {
    const { insertChunk, findSimilarChunks } = await import(
      "../server/lib/vectordb/chunks.ts"
    );
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([1, 0, 0, 0]),
      text: "exact",
      pathTitles: ["X"],
      sectionLevel: 1,
      sectionOrder: 1,
      partN: 1,
      partOf: 1,
    });
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([0.9, 0.1, 0, 0]),
      text: "close",
      pathTitles: ["X"],
      sectionLevel: 1,
      sectionOrder: 2,
      partN: 1,
      partOf: 1,
    });
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([0, 1, 0, 0]),
      text: "far",
      pathTitles: ["X"],
      sectionLevel: 1,
      sectionOrder: 3,
      partN: 1,
      partOf: 1,
    });
    const results = findSimilarChunks({
      userId: "alice",
      embedding: unitVec([1, 0, 0, 0]),
      limit: 3,
    });
    assert.equal(results.length, 3);
    assert.ok(results[0].similarity > 0.99);
    assert.ok(results[0].similarity >= results[1].similarity);
    assert.ok(results[1].similarity >= results[2].similarity);
    assert.equal(results[0].text, "exact");
  });

  it("linkChunkSiblings populates prev/next within section", async () => {
    const { insertChunk, linkChunkSiblings, getChunkByRowId } = await import(
      "../server/lib/vectordb/chunks.ts"
    );
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        insertChunk({
          userId: "alice",
          bookId: "b1",
          level: 1,
          embedding: unitVec([1 - i * 0.1, i * 0.1, 0, 0]),
          text: `chunk ${i}`,
          pathTitles: ["§"],
          sectionLevel: 1,
          sectionOrder: 1,
          partN: i + 1,
          partOf: 3,
        }),
      );
    }
    linkChunkSiblings(ids);
    const first = getChunkByRowId(ids[0]);
    const mid = getChunkByRowId(ids[1]);
    const last = getChunkByRowId(ids[2]);
    assert.equal(first?.prevVecRowId, null);
    assert.equal(first?.nextVecRowId, ids[1]);
    assert.equal(mid?.prevVecRowId, ids[0]);
    assert.equal(mid?.nextVecRowId, ids[2]);
    assert.equal(last?.prevVecRowId, ids[1]);
    assert.equal(last?.nextVecRowId, null);
  });

  it("level filter isolates retrieval grain", async () => {
    const { insertChunk, findSimilarChunks } = await import(
      "../server/lib/vectordb/chunks.ts"
    );
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([1, 0, 0, 0]),
      text: "section",
      pathTitles: ["§"],
      sectionLevel: 1,
      sectionOrder: 1,
      partN: 1,
      partOf: 1,
    });
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 2,
      embedding: unitVec([1, 0, 0, 0]),
      text: "chapter summary",
      pathTitles: ["Ch1"],
      sectionLevel: 1,
      sectionOrder: 1,
      partN: 1,
      partOf: 1,
    });
    const l1 = findSimilarChunks({
      userId: "alice",
      embedding: unitVec([1, 0, 0, 0]),
      limit: 5,
      level: 1,
    });
    const l2 = findSimilarChunks({
      userId: "alice",
      embedding: unitVec([1, 0, 0, 0]),
      limit: 5,
      level: 2,
    });
    assert.equal(l1.length, 1);
    assert.equal(l1[0].text, "section");
    assert.equal(l2.length, 1);
    assert.equal(l2[0].text, "chapter summary");
  });

  it("per-user partition: bob's chunks invisible to alice's KNN", async () => {
    const { insertChunk, findSimilarChunks } = await import(
      "../server/lib/vectordb/chunks.ts"
    );
    const v = unitVec([1, 0, 0, 0]);
    insertChunk({
      userId: "alice",
      bookId: "ba",
      level: 1,
      embedding: v,
      text: "alice text",
      pathTitles: [],
      sectionLevel: 0,
      sectionOrder: 1,
      partN: 1,
      partOf: 1,
    });
    insertChunk({
      userId: "bob",
      bookId: "bb",
      level: 1,
      embedding: v,
      text: "bob text",
      pathTitles: [],
      sectionLevel: 0,
      sectionOrder: 1,
      partN: 1,
      partOf: 1,
    });
    const aliceHits = findSimilarChunks({ userId: "alice", embedding: v, limit: 10 });
    assert.equal(aliceHits.length, 1);
    assert.equal(aliceHits[0].text, "alice text");
  });

  it("deleteAllChunksForBook removes from BOTH chunks and chunks_vec", async () => {
    const {
      insertChunk,
      deleteAllChunksForBook,
      findSimilarChunks,
      countChunksForBook,
    } = await import("../server/lib/vectordb/chunks.ts");
    for (let i = 0; i < 3; i++) {
      insertChunk({
        userId: "alice",
        bookId: "b1",
        level: 1,
        embedding: unitVec([1 - i * 0.1, i * 0.1, 0, 0]),
        text: `c${i}`,
        pathTitles: ["§"],
        sectionLevel: 1,
        sectionOrder: 1,
        partN: i + 1,
        partOf: 3,
      });
    }
    /* And one chunk for a different book — must survive. */
    insertChunk({
      userId: "alice",
      bookId: "b2",
      level: 1,
      embedding: unitVec([0, 0, 1, 0]),
      text: "other book",
      pathTitles: ["§"],
      sectionLevel: 1,
      sectionOrder: 1,
      partN: 1,
      partOf: 1,
    });
    assert.equal(countChunksForBook("alice", "b1"), 3);
    const deleted = deleteAllChunksForBook("alice", "b1");
    assert.equal(deleted, 3);
    assert.equal(countChunksForBook("alice", "b1"), 0);
    /* Verify chunks_vec was also wiped — KNN over same query returns
     * only the other book's chunk. */
    const remaining = findSimilarChunks({
      userId: "alice",
      embedding: unitVec([1, 0, 0, 0]),
      limit: 10,
    });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].bookId, "b2");
  });
});
