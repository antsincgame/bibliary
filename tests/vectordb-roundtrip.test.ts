/**
 * tests/vectordb-roundtrip.test.ts
 *
 * Интеграционные тесты vectordb-слоя против РЕАЛЬНОЙ LanceDB (через
 * lancedb.connect на mkdtemp директорию). Покрывает:
 *
 *   1. ensureCollection — идемпотентность (3× same name → одна table)
 *   2. listCollections / collectionExists / getCollectionInfo
 *   3. deleteCollection — drop + повторный ensure → пустая таблица
 *   4. vectorUpsert — round-trip всех metadata-полей включая null
 *   5. vectorUpsert — Arrow strict typing: row с пропущенным полем работает
 *   6. canonicalizeRow — extraJson catch-all
 *   7. vectorUpsertAdaptive — split на ошибке
 *   8. vectorCount
 *   9. vectorDeleteByWhere — delete by metadata filter, refuse empty filter
 *  10. vectorQueryNearest — top-N nearest, similarity > 0.99 для seeded
 *  11. scrollVectors — paged iteration, abort signal honored
 *  12. concurrent upserts — KeyedAsyncMutex serializuет в правильный порядок
 *
 * Каждый тест работает в собственной mkdtemp-директории, изолирован от
 * других через `setDataDirForTesting(tmpdir)` + `closeDb()`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  initVectorDb,
  closeDb,
  setDataDirForTesting,
  ensureCollection,
  listCollections,
  collectionExists,
  getCollectionInfo,
  deleteCollection,
  vectorUpsert,
  vectorUpsertAdaptive,
  vectorDeleteByWhere,
  vectorCount,
  vectorQueryNearest,
  canonicalizeRow,
  VECTOR_DIM,
} from "../electron/lib/vectordb/index.ts";
import { scrollVectors } from "../electron/lib/vectordb/scroll.ts";
import { _resetLocksForTesting } from "../electron/lib/vectordb/locks.ts";
import type { VectorPoint } from "../electron/lib/vectordb/points.ts";

interface Sandbox {
  dir: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vectordb-test-"));
  setDataDirForTesting(dir);
  await initVectorDb({ dataDir: dir });
  _resetLocksForTesting();
  return {
    dir,
    cleanup: async () => {
      await closeDb();
      setDataDirForTesting(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Build a deterministic L2-normalized 384-dim vector for testing. */
function unitVec(seed: number[]): number[] {
  const v = new Array<number>(VECTOR_DIM).fill(0);
  for (let i = 0; i < seed.length && i < VECTOR_DIM; i++) v[i] = seed[i];
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

function makePoint(id: string, vec: number[], metadata: Record<string, unknown> = {}): VectorPoint {
  return { id, embedding: vec, metadata, document: `doc-${id}` };
}

/* ─── canonicalizeRow (pure unit) ──────────────────────────────────── */

test("[vectordb] canonicalizeRow fills nulls for missing metadata fields", () => {
  const row = canonicalizeRow({
    id: "x",
    embedding: unitVec([1, 0, 0]),
    metadata: { bookId: "book-1" },
  });
  /* Пропущенные поля — null, не undefined */
  assert.equal(row.bookSourcePath, null);
  assert.equal(row.domain, null);
  assert.equal(row.essence, null);
  assert.equal(row.bookId, "book-1");
});

test("[vectordb] canonicalizeRow sends unknown metadata to extraJson", () => {
  const row = canonicalizeRow({
    id: "x",
    embedding: unitVec([1, 0]),
    metadata: { bookId: "b", customField: "value", anotherCustom: 42 },
  });
  assert.equal(row.bookId, "b");
  assert.ok(typeof row.extraJson === "string");
  const parsed = JSON.parse(row.extraJson as string) as Record<string, unknown>;
  assert.equal(parsed.customField, "value");
  assert.equal(parsed.anotherCustom, 42);
});

test("[vectordb] canonicalizeRow embedding dim mismatch → throw", () => {
  assert.throws(
    () => canonicalizeRow({
      id: "x",
      embedding: [1, 2, 3], /* dim=3, expected 384 */
      metadata: {},
    }),
    /embedding (must be array|dim mismatch)/,
  );
});

test("[vectordb] canonicalizeRow string[] in tagsCsv-style metadata → pipe-delimited", () => {
  const row = canonicalizeRow({
    id: "x",
    embedding: unitVec([1, 0]),
    metadata: { tagsCsv: ["alpha", "beta"] },
  });
  assert.equal(row.tagsCsv, "|alpha|beta|");
});

test("[vectordb] canonicalizeRow boolean isFictionOrWater stuffed into extraJson", () => {
  /* Bool-колонки в Lance требуют ≥1 byte bitmap — all-null batches падают.
   * Решение: исторические/новые boolean-поля идут в extraJson catch-all.
   * Round-trip через extractMetadataFromRow восстанавливает значение. */
  const row = canonicalizeRow({
    id: "x",
    embedding: unitVec([1, 0]),
    metadata: { isFictionOrWater: true },
  });
  assert.ok(typeof row.extraJson === "string");
  const parsed = JSON.parse(row.extraJson as string) as Record<string, unknown>;
  assert.equal(parsed.isFictionOrWater, true);
});

/* ─── ensureCollection ─────────────────────────────────────────────── */

test("[vectordb] ensureCollection idempotent — 3× same name = one table", async () => {
  const sb = await makeSandbox();
  try {
    const r1 = await ensureCollection({ name: "test-ens" });
    const r2 = await ensureCollection({ name: "test-ens" });
    const r3 = await ensureCollection({ name: "test-ens" });

    assert.equal(r1.created, true);
    assert.equal(r2.created, false);
    assert.equal(r3.created, false);

    const tables = await listCollections();
    const matches = tables.filter((t) => t === "test-ens");
    assert.equal(matches.length, 1, "only one table should exist");
  } finally {
    await sb.cleanup();
  }
});

test("[vectordb] listCollections / collectionExists / getCollectionInfo", async () => {
  const sb = await makeSandbox();
  try {
    assert.equal(await collectionExists("missing"), false);
    assert.equal(await getCollectionInfo("missing"), null);

    await ensureCollection({ name: "c1" });
    await ensureCollection({ name: "c2" });

    const all = await listCollections();
    assert.ok(all.includes("c1"));
    assert.ok(all.includes("c2"));

    assert.equal(await collectionExists("c1"), true);
    const info = await getCollectionInfo("c1");
    assert.ok(info !== null);
    assert.equal(info!.name, "c1");
    assert.equal(info!.rowCount, 0);
  } finally {
    await sb.cleanup();
  }
});

test("[vectordb] deleteCollection idempotent — drop + ensure recreates empty", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "wipeme" });
    await vectorUpsert("wipeme", [makePoint("p1", unitVec([1, 0, 0]))]);
    assert.equal(await vectorCount("wipeme"), 1);

    const r = await deleteCollection("wipeme");
    assert.equal(r.deleted, true);
    assert.equal(await collectionExists("wipeme"), false);

    /* idempotent — second delete is no-op */
    const r2 = await deleteCollection("wipeme");
    assert.equal(r2.deleted, false);

    /* recreate → empty */
    await ensureCollection({ name: "wipeme" });
    assert.equal(await vectorCount("wipeme"), 0);
  } finally {
    await sb.cleanup();
  }
});

/* ─── upsert / count / read-back ────────────────────────────────────── */

test("[vectordb] vectorUpsert round-trips metadata via queryNearest", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "rt" });
    const v = unitVec([1, 0, 0, 0]);
    await vectorUpsert("rt", [
      {
        id: "p1",
        embedding: v,
        document: "essence text",
        metadata: {
          bookId: "book-42",
          domain: "math",
          essence: "essence text",
          tagsCsv: ["alpha", "beta"],
        },
      },
    ]);

    assert.equal(await vectorCount("rt"), 1);

    const neighbors = await vectorQueryNearest("rt", v, 1);
    assert.equal(neighbors.length, 1);
    assert.equal(neighbors[0].id, "p1");
    assert.equal(neighbors[0].document, "essence text");
    assert.ok(neighbors[0].similarity > 0.99, `similarity = ${neighbors[0].similarity}`);
    assert.equal(neighbors[0].metadata.bookId, "book-42");
    assert.equal(neighbors[0].metadata.domain, "math");
    assert.equal(neighbors[0].metadata.tagsCsv, "|alpha|beta|");
  } finally {
    await sb.cleanup();
  }
});

test("[vectordb] vectorUpsert: rows with different metadata-key sets coexist (Arrow nullable)", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "mixed" });
    await vectorUpsert("mixed", [
      makePoint("p1", unitVec([1, 0]), { bookId: "b1", domain: "math" }),
      /* p2 lacks `domain` field — must NOT crash Arrow encoding */
      makePoint("p2", unitVec([0, 1]), { bookId: "b2" }),
      /* p3 has neither — pure essence-only */
      makePoint("p3", unitVec([1, 1]), { essence: "alone" }),
    ]);
    assert.equal(await vectorCount("mixed"), 3);
  } finally {
    await sb.cleanup();
  }
});

test("[vectordb] vectorUpsert idempotent — same id twice = update", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "idem" });
    const v = unitVec([1, 0]);
    await vectorUpsert("idem", [makePoint("p1", v, { bookId: "b1" })]);
    await vectorUpsert("idem", [makePoint("p1", v, { bookId: "b1-updated" })]);

    assert.equal(await vectorCount("idem"), 1, "no duplication on same id");
    const neighbors = await vectorQueryNearest("idem", v, 1);
    assert.equal(neighbors[0].metadata.bookId, "b1-updated");
  } finally {
    await sb.cleanup();
  }
});

test("[vectordb] vectorUpsertAdaptive splits on per-row failure", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "adapt" });
    /* Inject a failing point — embedding wrong dim — so first batch throws.
     * Adaptive split should isolate and propagate that single bad point's error. */
    const ok1 = makePoint("p1", unitVec([1, 0]), { bookId: "b1" });
    const ok2 = makePoint("p2", unitVec([0, 1]), { bookId: "b2" });
    const bad: VectorPoint = { id: "bad", embedding: [1, 2, 3], metadata: {} };

    await assert.rejects(
      vectorUpsertAdaptive("adapt", [ok1, bad, ok2]),
      /embedding (must be array|dim mismatch)/,
    );

    /* Despite failure, ok1 OR ok2 may have landed depending on split order;
     * the contract is "at minimum one valid row reachable, bad one not". */
    const count = await vectorCount("adapt");
    assert.ok(count >= 1, `expected ≥1 ok row, got ${count}`);
  } finally {
    await sb.cleanup();
  }
});

/* ─── delete ───────────────────────────────────────────────────────── */

test("[vectordb] vectorDeleteByWhere removes matching, leaves rest", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "del" });
    await vectorUpsert("del", [
      makePoint("a", unitVec([1, 0]), { bookId: "b1", domain: "math" }),
      makePoint("b", unitVec([0, 1]), { bookId: "b1", domain: "cs" }),
      makePoint("c", unitVec([1, 1]), { bookId: "b2", domain: "math" }),
    ]);
    assert.equal(await vectorCount("del"), 3);

    await vectorDeleteByWhere("del", { bookId: "b1" });
    assert.equal(await vectorCount("del"), 1, "b1 (2 rows) deleted, b2 (1) kept");
  } finally {
    await sb.cleanup();
  }
});

test("[vectordb] vectorDeleteByWhere refuses empty filter", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "del2" });
    await vectorUpsert("del2", [makePoint("a", unitVec([1, 0]), { bookId: "b1" })]);
    await assert.rejects(
      vectorDeleteByWhere("del2", {}),
      /refuses empty filter/,
    );
    assert.equal(await vectorCount("del2"), 1, "empty filter must NOT wipe");
  } finally {
    await sb.cleanup();
  }
});

/* ─── queryNearest with where filter ───────────────────────────────── */

test("[vectordb] vectorQueryNearest respects where filter", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "qf" });
    const target = unitVec([1, 0, 0, 0]);
    await vectorUpsert("qf", [
      makePoint("near-math", target, { bookId: "b1", domain: "math" }),
      makePoint("near-cs", unitVec([0.99, 0.05, 0, 0]), { bookId: "b1", domain: "cs" }),
      makePoint("far", unitVec([0, 0, 1, 0]), { bookId: "b1", domain: "math" }),
    ]);
    const neighbors = await vectorQueryNearest("qf", target, 5, { where: { domain: "cs" } });
    assert.equal(neighbors.length, 1, "only 1 row matches domain=cs");
    assert.equal(neighbors[0].id, "near-cs");
  } finally {
    await sb.cleanup();
  }
});

/* ─── scrollVectors ────────────────────────────────────────────────── */

test("[vectordb] scrollVectors paginated yield (offset path)", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "scr" });
    const points: VectorPoint[] = [];
    for (let i = 0; i < 25; i++) {
      points.push(makePoint(`p${i}`, unitVec([Math.sin(i), Math.cos(i)]), { bookId: `book-${i % 5}` }));
    }
    await vectorUpsert("scr", points);
    assert.equal(await vectorCount("scr"), 25);

    const seen: string[] = [];
    for await (const page of scrollVectors({
      tableName: "scr",
      pageSize: 10,
      include: ["metadatas"],
    })) {
      seen.push(...page.ids);
    }
    assert.equal(seen.length, 25);
    /* ids should be unique even if page-internal order is unspecified */
    assert.equal(new Set(seen).size, 25);
  } finally {
    await sb.cleanup();
  }
});

test("[vectordb] scrollVectors honors maxItems hard cap", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "cap" });
    const pts: VectorPoint[] = [];
    for (let i = 0; i < 30; i++) pts.push(makePoint(`p${i}`, unitVec([i, 0]), {}));
    await vectorUpsert("cap", pts);

    const seen: string[] = [];
    for await (const page of scrollVectors({
      tableName: "cap",
      pageSize: 10,
      maxItems: 15,
    })) {
      seen.push(...page.ids);
    }
    assert.equal(seen.length, 15);
  } finally {
    await sb.cleanup();
  }
});

test("[vectordb] scrollVectors aborts on signal", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "abrt" });
    const pts: VectorPoint[] = [];
    for (let i = 0; i < 30; i++) pts.push(makePoint(`p${i}`, unitVec([i, 0]), {}));
    await vectorUpsert("abrt", pts);

    const ctl = new AbortController();
    ctl.abort();

    await assert.rejects(
      (async () => {
        for await (const _ of scrollVectors({
          tableName: "abrt",
          pageSize: 10,
          signal: ctl.signal,
        })) {
          /* never gets here */
        }
      })(),
      /aborted/,
    );
  } finally {
    await sb.cleanup();
  }
});

/* ─── concurrency ──────────────────────────────────────────────────── */

test("[vectordb] concurrent upserts: KeyedAsyncMutex preserves all writes", async () => {
  const sb = await makeSandbox();
  try {
    await ensureCollection({ name: "race" });
    const concurrent = 20;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < concurrent; i++) {
      promises.push(vectorUpsert("race", [makePoint(`p${i}`, unitVec([i, 0]), { bookId: `b${i}` })]));
    }
    await Promise.all(promises);
    assert.equal(await vectorCount("race"), concurrent);
  } finally {
    await sb.cleanup();
  }
});
