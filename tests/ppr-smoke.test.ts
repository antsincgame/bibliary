/**
 * Phase Δf — PPR + entity seeding + graph scoring smoke. Pure
 * graph-algorithm tests (no LLM, no embedder). Uses in-memory
 * adjacency override so PPR convergence is tested without sqlite.
 * The end-to-end DB-backed paths get one round-trip case each.
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "ppr-"));
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
  db.exec("DELETE FROM relations");
  db.exec("DELETE FROM entity_aliases");
  db.exec("DELETE FROM entities");
});

describe("personalizedPageRank", () => {
  it("returns empty when seeds aren't in graph", async () => {
    const { personalizedPageRank } = await import("../server/lib/vectordb/ppr.ts");
    /* Star: 1 connected to 2,3,4. Seed an id not in adjacency. */
    const adj = new Map<number, Set<number>>([
      [1, new Set([2, 3, 4])],
      [2, new Set([1])],
      [3, new Set([1])],
      [4, new Set([1])],
    ]);
    const r = personalizedPageRank({
      userId: "alice",
      seeds: [{ entityId: 99, weight: 1 }],
      adjacencyOverride: adj,
    });
    assert.equal(r.scores.size, 0);
  });

  it("single-seed star graph: seed gets most mass, leaves split remainder evenly", async () => {
    const { personalizedPageRank } = await import("../server/lib/vectordb/ppr.ts");
    const adj = new Map<number, Set<number>>([
      [1, new Set([2, 3, 4])],
      [2, new Set([1])],
      [3, new Set([1])],
      [4, new Set([1])],
    ]);
    const r = personalizedPageRank({
      userId: "alice",
      seeds: [{ entityId: 1, weight: 1 }],
      adjacencyOverride: adj,
    });
    const s1 = r.scores.get(1) ?? 0;
    const s2 = r.scores.get(2) ?? 0;
    const s3 = r.scores.get(3) ?? 0;
    const s4 = r.scores.get(4) ?? 0;
    assert.ok(s1 > s2, "seed gets more than any leaf");
    assert.ok(Math.abs(s2 - s3) < 1e-3, "leaves symmetric");
    assert.ok(Math.abs(s3 - s4) < 1e-3, "leaves symmetric");
    /* Mass roughly conserved — sum near 1. */
    const total = s1 + s2 + s3 + s4;
    assert.ok(Math.abs(total - 1) < 1e-2, `expected sum~1, got ${total}`);
  });

  it("single-seed path graph: closer hop ranks higher than farther", async () => {
    const { personalizedPageRank } = await import("../server/lib/vectordb/ppr.ts");
    /* Path 1-2-3-4-5. Seed at 1. PPR walk lazily wanders away — the
     * farthest node gets the least mass. With α=0.15 the seed itself
     * does not necessarily hold the most mass (mid nodes get
     * crossing-paths boost) so we only assert the geodesic-distance
     * ranking against the farthest node 5. */
    const adj = new Map<number, Set<number>>([
      [1, new Set([2])],
      [2, new Set([1, 3])],
      [3, new Set([2, 4])],
      [4, new Set([3, 5])],
      [5, new Set([4])],
    ]);
    const r = personalizedPageRank({
      userId: "alice",
      seeds: [{ entityId: 1, weight: 1 }],
      adjacencyOverride: adj,
    });
    const s1 = r.scores.get(1) ?? 0;
    const s2 = r.scores.get(2) ?? 0;
    const s3 = r.scores.get(3) ?? 0;
    const s4 = r.scores.get(4) ?? 0;
    const s5 = r.scores.get(5) ?? 0;
    /* Seed node and its 1-hop neighbour outrank the far end. */
    assert.ok(s1 > s5, `expected s1 > s5, got ${s1} vs ${s5}`);
    assert.ok(s2 > s5, `expected s2 > s5, got ${s2} vs ${s5}`);
    /* Monotone decay from far end toward seed in 1-3 hops. */
    assert.ok(s4 > s5, "one-hop-back outranks farthest");
    assert.ok(s3 > s5, "two-hops-back outranks farthest");
  });

  it("two-seed symmetric path: PPR is symmetric across the centre", async () => {
    const { personalizedPageRank } = await import("../server/lib/vectordb/ppr.ts");
    /* Two seeds at the ends of a path. By construction s1==s5, s2==s4. */
    const adj = new Map<number, Set<number>>([
      [1, new Set([2])],
      [2, new Set([1, 3])],
      [3, new Set([2, 4])],
      [4, new Set([3, 5])],
      [5, new Set([4])],
    ]);
    const r = personalizedPageRank({
      userId: "alice",
      seeds: [
        { entityId: 1, weight: 1 },
        { entityId: 5, weight: 1 },
      ],
      adjacencyOverride: adj,
    });
    const s1 = r.scores.get(1) ?? 0;
    const s2 = r.scores.get(2) ?? 0;
    const s4 = r.scores.get(4) ?? 0;
    const s5 = r.scores.get(5) ?? 0;
    assert.ok(Math.abs(s1 - s5) < 1e-3, "symmetric seeds equal");
    assert.ok(Math.abs(s2 - s4) < 1e-3, "symmetric one-hop equal");
  });

  it("returns 0 when no edges in graph", async () => {
    const { personalizedPageRank } = await import("../server/lib/vectordb/ppr.ts");
    const r = personalizedPageRank({
      userId: "alice",
      seeds: [{ entityId: 1, weight: 1 }],
      adjacencyOverride: new Map(),
    });
    assert.equal(r.scores.size, 0);
  });
});

describe("findEntityIdsForQuery (DB-backed)", () => {
  it("matches canonical exact + alias + substring", async () => {
    const { upsertEntity } = await import("../server/lib/vectordb/graph.ts");
    const { findEntityIdsForQuery } = await import("../server/lib/vectordb/ppr.ts");
    upsertEntity("alice", "Saturn V");
    upsertEntity("alice", "saturn v.");
    upsertEntity("alice", "Wernher von Braun");
    upsertEntity("alice", "Apollo 11");
    /* Insert another book/user we should NOT match. */
    upsertEntity("bob", "Saturn V");

    /* Direct canonical hit. */
    const ids1 = findEntityIdsForQuery("alice", "Saturn V");
    assert.ok(ids1.length >= 1);
    /* Substring through a token. */
    const ids2 = findEntityIdsForQuery("alice", "tell me about saturn");
    assert.ok(ids2.length >= 1);
    /* No alice match for bob's seed. */
    const ids3 = findEntityIdsForQuery("bob", "Apollo");
    assert.equal(ids3.length, 0, "bob has no Apollo entity");
  });

  it("drops 1-2 char tokens (stopwords / noise)", async () => {
    const { upsertEntity } = await import("../server/lib/vectordb/graph.ts");
    const { findEntityIdsForQuery } = await import("../server/lib/vectordb/ppr.ts");
    upsertEntity("alice", "X");
    /* Tokenization filter requires ≥3 chars; "X" itself canonicalizes
     * to "x" which is below threshold. The whole-query path also fails
     * because "X" canonical is < 3. */
    const ids = findEntityIdsForQuery("alice", "X");
    assert.equal(ids.length, 0);
  });
});

describe("scoreChunksByGraph (DB-backed)", () => {
  it("chunk score = sum of PPR for entities it produced relations on", async () => {
    const { ingestRelations } = await import("../server/lib/vectordb/graph.ts");
    const { scoreChunksByGraph } = await import("../server/lib/vectordb/ppr.ts");
    /* Two chunks. Chunk 10 produces 2 relations on highly-scored
     * entities; chunk 20 produces 1 relation on a low-scored entity.
     * scoreChunksByGraph should rank 10 > 20. */
    const ingest1 = ingestRelations({
      userId: "alice",
      bookId: "b1",
      triples: [
        { subject: "A", predicate: "links", object: "B" },
        { subject: "A", predicate: "uses", object: "C" },
      ],
      sourceChunkVecRowId: 10,
    });
    const ingest2 = ingestRelations({
      userId: "alice",
      bookId: "b1",
      triples: [{ subject: "D", predicate: "rare", object: "E" }],
      sourceChunkVecRowId: 20,
    });
    assert.equal(ingest1.relationsInserted, 2);
    assert.equal(ingest2.relationsInserted, 1);
    /* Fake PPR: pretend A, B, C are high-scored; D, E are low. We need
     * to know their entity IDs — fetch from DB. */
    const { getVectorDb } = await import("../server/lib/vectordb/db.ts");
    const { db } = getVectorDb();
    const rows = db
      .prepare(`SELECT id, canonical FROM entities WHERE user_id = ?`)
      .all("alice") as Array<{ id: number; canonical: string }>;
    const byCanon = new Map(rows.map((r) => [r.canonical, r.id]));
    const pprScores = new Map<number, number>();
    pprScores.set(byCanon.get("a")!, 0.5);
    pprScores.set(byCanon.get("b")!, 0.5);
    pprScores.set(byCanon.get("c")!, 0.5);
    pprScores.set(byCanon.get("d")!, 0.01);
    pprScores.set(byCanon.get("e")!, 0.01);
    const scores = scoreChunksByGraph({
      userId: "alice",
      chunkRowIds: [10, 20],
      pprScores,
    });
    const s10 = scores.get(10) ?? 0;
    const s20 = scores.get(20) ?? 0;
    assert.ok(s10 > s20, `expected chunk 10 > chunk 20, got ${s10} / ${s20}`);
  });
});
