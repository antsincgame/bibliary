/**
 * Phase Δc — knowledge graph smoke. Verifies:
 *   - canonicalizeEntityName: lowercase, punctuation strip, whitespace normalize
 *   - upsertEntity: find-or-create with alias recording on alt spelling
 *   - insertRelation: stores typed edge + back-link to source chunk
 *   - ingestRelations: full triple batch in one transaction; canonicalizes
 *     subject/object; empty canonical drops the triple
 *   - getEntitiesForBookRegistry: only entities touched by this book
 *   - per-user isolation: bob's entities invisible to alice's queries
 *   - deleteGraphForBook: sweeps relations + orphan entities, keeps
 *     entities still referenced by another book alive
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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "vec-graph-"));
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

describe("knowledge graph", () => {
  it("canonicalizeEntityName: lowercase, punct strip, ws collapse", async () => {
    const { canonicalizeEntityName } = await import("../server/lib/vectordb/graph.ts");
    assert.equal(canonicalizeEntityName("Saturn V."), "saturn v");
    assert.equal(canonicalizeEntityName("  WERNHER   von  BRAUN  "), "wernher von braun");
    assert.equal(canonicalizeEntityName("\"FEM error\""), "fem error");
    assert.equal(canonicalizeEntityName("Apollo, 11!"), "apollo 11");
  });

  it("upsertEntity: find-or-create, alt spelling becomes alias", async () => {
    const { upsertEntity } = await import("../server/lib/vectordb/graph.ts");
    const a = upsertEntity("alice", "Saturn V");
    const b = upsertEntity("alice", "saturn v.");
    assert.equal(a.id, b.id, "same canonical → same entity");
    assert.equal(a.display, "Saturn V", "first spelling stays as display");

    const { getVectorDb } = await import("../server/lib/vectordb/db.ts");
    const { db } = getVectorDb();
    const aliases = db
      .prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY id`)
      .all(a.id) as Array<{ alias: string }>;
    assert.deepEqual(
      aliases.map((r) => r.alias),
      ["saturn v."],
      "alt spelling stored as alias",
    );
  });

  it("ingestRelations: batches triples, returns entity+relation counts", async () => {
    const { ingestRelations, countEntitiesForUser, countRelationsForBook } =
      await import("../server/lib/vectordb/graph.ts");
    const { entitiesTouched, relationsInserted } = ingestRelations({
      userId: "alice",
      bookId: "b1",
      triples: [
        { subject: "Saturn V", predicate: "designed_by", object: "Wernher von Braun" },
        { subject: "Apollo 11", predicate: "launched_with", object: "Saturn V" },
      ],
      sourceChunkVecRowId: 42,
    });
    assert.equal(relationsInserted, 2);
    /* 3 distinct entities: Saturn V, Wernher von Braun, Apollo 11. */
    assert.equal(entitiesTouched, 3);
    assert.equal(countEntitiesForUser("alice"), 3);
    assert.equal(countRelationsForBook("alice", "b1"), 2);
  });

  it("ingestRelations: source_chunk_vec_rowid persisted on each edge", async () => {
    const { ingestRelations } = await import("../server/lib/vectordb/graph.ts");
    ingestRelations({
      userId: "alice",
      bookId: "b1",
      triples: [{ subject: "X", predicate: "produces", object: "Y" }],
      sourceChunkVecRowId: 7,
    });
    const { getVectorDb } = await import("../server/lib/vectordb/db.ts");
    const { db } = getVectorDb();
    const row = db
      .prepare(`SELECT source_chunk_vec_rowid AS r FROM relations LIMIT 1`)
      .get() as { r: number };
    assert.equal(row.r, 7);
  });

  it("ingestRelations: drops triples whose canonical is empty", async () => {
    const { ingestRelations, countEntitiesForUser } = await import(
      "../server/lib/vectordb/graph.ts"
    );
    const r = ingestRelations({
      userId: "alice",
      bookId: "b1",
      triples: [
        { subject: '"!"', predicate: "any", object: "real" },
        { subject: "real", predicate: "links_to", object: "also real" },
      ],
    });
    /* First triple is dropped — subject "!" canonicalizes to "".
     * Only "real" and "also real" get created. */
    assert.equal(r.relationsInserted, 1);
    assert.equal(countEntitiesForUser("alice"), 2);
  });

  it("getEntitiesForBookRegistry: scoped per book", async () => {
    const { ingestRelations, getEntitiesForBookRegistry } = await import(
      "../server/lib/vectordb/graph.ts"
    );
    ingestRelations({
      userId: "alice",
      bookId: "b1",
      triples: [{ subject: "A", predicate: "links", object: "B" }],
    });
    ingestRelations({
      userId: "alice",
      bookId: "b2",
      triples: [{ subject: "C", predicate: "links", object: "D" }],
    });
    const b1Reg = getEntitiesForBookRegistry("alice", "b1");
    const names = new Set(b1Reg.map((r) => r.display));
    assert.ok(names.has("A"));
    assert.ok(names.has("B"));
    assert.ok(!names.has("C"));
    assert.ok(!names.has("D"));
  });

  it("per-user isolation: bob does NOT see alice's entities", async () => {
    const { upsertEntity, countEntitiesForUser } = await import(
      "../server/lib/vectordb/graph.ts"
    );
    upsertEntity("alice", "Shared");
    upsertEntity("bob", "Shared");
    /* Same canonical "shared" exists for both — they are SEPARATE rows
     * because UNIQUE(user_id, canonical) scopes to user. */
    assert.equal(countEntitiesForUser("alice"), 1);
    assert.equal(countEntitiesForUser("bob"), 1);
  });

  it("deleteGraphForBook: relations gone, orphan entities swept, shared survives", async () => {
    const {
      ingestRelations,
      deleteGraphForBook,
      countEntitiesForUser,
      countRelationsForBook,
    } = await import("../server/lib/vectordb/graph.ts");
    /* Book 1 introduces X→Y. */
    ingestRelations({
      userId: "alice",
      bookId: "b1",
      triples: [{ subject: "X", predicate: "rel", object: "Y" }],
    });
    /* Book 2 also references X (different relation). X is shared. */
    ingestRelations({
      userId: "alice",
      bookId: "b2",
      triples: [{ subject: "X", predicate: "rel", object: "Z" }],
    });
    assert.equal(countEntitiesForUser("alice"), 3); // X, Y, Z

    const r = deleteGraphForBook("alice", "b1");
    assert.equal(r.relationsDeleted, 1);
    /* Y was only referenced by b1 → swept. X survives (still in b2). */
    assert.equal(r.entitiesDeleted, 1);
    assert.equal(countEntitiesForUser("alice"), 2);
    assert.equal(countRelationsForBook("alice", "b1"), 0);
    assert.equal(countRelationsForBook("alice", "b2"), 1);
  });
});
