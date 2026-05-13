/**
 * Phase Δd — chunks helper smoke for L2 parent linking and per-unit
 * listing. Pure sqlite-vec ops; no LLM. The summarizer itself is
 * exercised via integration tests once a provider is mockable.
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "chunks-l2-"));
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

describe("L2 parent linking + per-unit listing", () => {
  it("setParentForChunks: reparents L1 children to L2 summary", async () => {
    const { insertChunk, setParentForChunks, getChunkByRowId } = await import(
      "../server/lib/vectordb/chunks.ts"
    );
    const l1a = insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([1, 0, 0, 0]),
      text: "first L1",
      pathTitles: ["Ch1"],
      sectionLevel: 1,
      sectionOrder: 1,
      partN: 1,
      partOf: 2,
    });
    const l1b = insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([0.9, 0.1, 0, 0]),
      text: "second L1",
      pathTitles: ["Ch1"],
      sectionLevel: 1,
      sectionOrder: 1,
      partN: 2,
      partOf: 2,
    });
    const l2 = insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 2,
      embedding: unitVec([0.95, 0.05, 0, 0]),
      text: "chapter summary",
      pathTitles: ["Ch1"],
      sectionLevel: 1,
      sectionOrder: 1,
      partN: 1,
      partOf: 1,
    });
    setParentForChunks([l1a, l1b], l2);
    assert.equal(getChunkByRowId(l1a)?.parentVecRowId, l2);
    assert.equal(getChunkByRowId(l1b)?.parentVecRowId, l2);
    /* L2 itself has no parent (it's at the top of this unit's tree). */
    assert.equal(getChunkByRowId(l2)?.parentVecRowId, null);
  });

  it("listL1ChunksForUnit: returns only L1 of that section, ordered by partN", async () => {
    const { insertChunk, listL1ChunksForUnit } = await import(
      "../server/lib/vectordb/chunks.ts"
    );
    /* Three L1 chunks in section 5, plus one L2 summary same section,
     * plus an L1 in a different section. listL1ChunksForUnit must
     * return ONLY the three section-5 L1s in part_n ASC order. */
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([0, 1, 0, 0]),
      text: "section 5 part 2",
      pathTitles: ["§5"],
      sectionLevel: 1,
      sectionOrder: 5,
      partN: 2,
      partOf: 3,
    });
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([1, 0, 0, 0]),
      text: "section 5 part 1",
      pathTitles: ["§5"],
      sectionLevel: 1,
      sectionOrder: 5,
      partN: 1,
      partOf: 3,
    });
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([0, 0, 1, 0]),
      text: "section 5 part 3",
      pathTitles: ["§5"],
      sectionLevel: 1,
      sectionOrder: 5,
      partN: 3,
      partOf: 3,
    });
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 2,
      embedding: unitVec([0.3, 0.3, 0.3, 0]),
      text: "section 5 summary",
      pathTitles: ["§5"],
      sectionLevel: 1,
      sectionOrder: 5,
      partN: 1,
      partOf: 1,
    });
    insertChunk({
      userId: "alice",
      bookId: "b1",
      level: 1,
      embedding: unitVec([0, 0, 0, 1]),
      text: "section 6 part 1",
      pathTitles: ["§6"],
      sectionLevel: 1,
      sectionOrder: 6,
      partN: 1,
      partOf: 1,
    });

    const list = listL1ChunksForUnit("alice", "b1", 5);
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((c) => c.partN),
      [1, 2, 3],
      "ordered by part_n ASC",
    );
    /* All level=1, all section_order=5. */
    for (const c of list) {
      assert.equal(c.level, 1);
      assert.equal(c.sectionOrder, 5);
    }
  });
});
