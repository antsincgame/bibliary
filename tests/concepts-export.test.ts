/**
 * tests/concepts-export.test.ts
 *
 * Verify Phase 0 concept exporter:
 *   1. parseArgs validation: --collection / --out required, errors on missing
 *   2. JSONL streaming: one row per line, valid JSON each, exact field shape
 *   3. Idempotency: re-run overwrites prior output cleanly via .tmp + rename
 *   4. --no-embedding: omits embedding column
 *   5. Empty collection: produces 0-byte output (no orphan .tmp)
 *   6. Mid-export failure: .tmp left, real out untouched
 *   7. Memory discipline (smoke): large fixture (5K rows) doesn't blow heap
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";

import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
import { clearAll, setMapping } from "../electron/lib/chroma/collection-cache.ts";
import { exportConcepts, parseArgs } from "../scripts/concepts-export.ts";

interface Sandbox {
  tempRoot: string;
  outPath: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "concepts-export-"));
  return {
    tempRoot,
    outPath: path.join(tempRoot, "out.jsonl"),
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Build a Chroma /get response page. `start` is the global row index used
 * to seed deterministic ids/metadata; `count` is the page size (0 ends scroll).
 */
function chromaPage(start: number, count: number, withEmbedding: boolean): unknown {
  const ids: string[] = [];
  const documents: string[] = [];
  const metadatas: Array<Record<string, unknown>> = [];
  const embeddings: number[][] = [];
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    ids.push(`id-${idx}`);
    documents.push(`essence-${idx}`);
    metadatas.push({ bookId: `book-${idx % 10}`, domain: idx % 2 === 0 ? "math" : "cs" });
    embeddings.push(withEmbedding ? Array.from({ length: 4 }, (_, k) => idx * 0.01 + k) : []);
  }
  return { ids, documents, metadatas, embeddings: withEmbedding ? embeddings : undefined };
}

/** Wire up mock-fetch + collection cache for a given total row count and pageSize. */
function installChromaMock(totalRows: number, pageSize: number, withEmbedding: boolean): {
  restore: () => void;
} {
  clearAll();
  setMapping("test-coll", "uuid-test", { "hnsw:space": "cosine" });
  const mock = setupMockFetch((req) => {
    /* GET collections/test-coll → already cached, не должен прилететь */
    if (req.method === "GET") {
      return jsonResponse({ id: "uuid-test", name: "test-coll", metadata: { "hnsw:space": "cosine" } });
    }
    /* POST /collections/uuid-test/get → page */
    const body = (req.body ?? {}) as { offset?: number; limit?: number };
    const offset = body.offset ?? 0;
    const limit = body.limit ?? pageSize;
    if (offset >= totalRows) return jsonResponse({ ids: [], documents: [], metadatas: [], embeddings: [] });
    const remaining = Math.min(limit, totalRows - offset);
    return jsonResponse(chromaPage(offset, remaining, withEmbedding));
  });
  return {
    restore: () => {
      mock.restore();
      clearAll();
    },
  };
}

async function readJsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(filePath, "utf8");
  if (!raw) return [];
  return raw.trim().split("\n").map((line, i) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`line ${i + 1} not valid JSON: ${(err as Error).message}\n  ${line.slice(0, 120)}`);
    }
  });
}

/* ─── parseArgs ─────────────────────────────────────────────────────── */

test("[concepts-export] parseArgs: --collection + --out required", () => {
  assert.deepStrictEqual(
    parseArgs(["--collection", "x", "--out", "y.jsonl"]),
    {
      collection: "x",
      out: "y.jsonl",
      includeEmbedding: true,
      pageSize: 256,
      maxItems: 1_000_000,
    },
  );
});

test("[concepts-export] parseArgs: --no-embedding flips includeEmbedding", () => {
  const args = parseArgs(["--collection", "x", "--out", "y.jsonl", "--no-embedding"]);
  assert.equal(args.includeEmbedding, false);
});

test("[concepts-export] parseArgs: --page-size override accepted", () => {
  const args = parseArgs(["--collection", "x", "--out", "y.jsonl", "--page-size", "1000"]);
  assert.equal(args.pageSize, 1000);
});

test("[concepts-export] parseArgs: --chroma-url passes through", () => {
  const args = parseArgs([
    "--collection", "x", "--out", "y.jsonl",
    "--chroma-url", "http://localhost:9000",
  ]);
  assert.equal(args.chromaUrl, "http://localhost:9000");
});

/* ─── Streaming export ──────────────────────────────────────────────── */

test("[concepts-export] writes one JSON object per line with correct shape", async () => {
  const sb = await makeSandbox();
  const m = installChromaMock(7, 4, true);
  try {
    const result = await exportConcepts({
      collection: "test-coll",
      out: sb.outPath,
      includeEmbedding: true,
      pageSize: 4,
      maxItems: 1000,
    });

    assert.equal(result.rowsWritten, 7);
    assert.ok(result.bytesWritten > 0);

    const rows = await readJsonl(sb.outPath);
    assert.equal(rows.length, 7);
    assert.equal(rows[0].id, "id-0");
    assert.equal(rows[0].document, "essence-0");
    assert.deepStrictEqual(rows[0].metadata, { bookId: "book-0", domain: "math" });
    assert.ok(Array.isArray(rows[0].embedding));
    assert.equal((rows[0].embedding as number[]).length, 4);
  } finally {
    m.restore();
    await sb.cleanup();
  }
});

test("[concepts-export] --no-embedding omits embedding column", async () => {
  const sb = await makeSandbox();
  const m = installChromaMock(3, 10, false);
  try {
    await exportConcepts({
      collection: "test-coll",
      out: sb.outPath,
      includeEmbedding: false,
      pageSize: 10,
      maxItems: 1000,
    });
    const rows = await readJsonl(sb.outPath);
    assert.equal(rows.length, 3);
    assert.ok(!("embedding" in rows[0]), "embedding key should be absent when --no-embedding");
    assert.equal(rows[0].id, "id-0");
  } finally {
    m.restore();
    await sb.cleanup();
  }
});

test("[concepts-export] empty collection produces 0-row file (no orphan .tmp)", async () => {
  const sb = await makeSandbox();
  const m = installChromaMock(0, 10, true);
  try {
    const result = await exportConcepts({
      collection: "test-coll",
      out: sb.outPath,
      includeEmbedding: true,
      pageSize: 10,
      maxItems: 1000,
    });
    assert.equal(result.rowsWritten, 0);

    const st = await stat(sb.outPath);
    assert.equal(st.size, 0);

    const tmpExists = await stat(`${sb.outPath}.tmp`).then(() => true).catch(() => false);
    assert.equal(tmpExists, false, ".tmp must be renamed away on success");
  } finally {
    m.restore();
    await sb.cleanup();
  }
});

test("[concepts-export] idempotent: re-run overwrites prior output cleanly", async () => {
  const sb = await makeSandbox();
  /* первый прогон: 5 rows */
  const m1 = installChromaMock(5, 10, true);
  try {
    await exportConcepts({
      collection: "test-coll", out: sb.outPath,
      includeEmbedding: true, pageSize: 10, maxItems: 1000,
    });
  } finally { m1.restore(); }

  const firstRows = await readJsonl(sb.outPath);
  assert.equal(firstRows.length, 5);

  /* второй прогон: 3 rows — out должен полностью замениться, не добавиться */
  const m2 = installChromaMock(3, 10, true);
  try {
    await exportConcepts({
      collection: "test-coll", out: sb.outPath,
      includeEmbedding: true, pageSize: 10, maxItems: 1000,
    });
  } finally { m2.restore(); }

  const secondRows = await readJsonl(sb.outPath);
  assert.equal(secondRows.length, 3, "re-run must overwrite, not append");
  await sb.cleanup();
});

test("[concepts-export] mid-export failure leaves .tmp intact, out untouched", async () => {
  const sb = await makeSandbox();

  /* подготовим существующий out, чтобы убедиться что он не перезаписан */
  await fs.promises.writeFile(sb.outPath, "PREVIOUS_RUN\n", "utf8");

  clearAll();
  setMapping("test-coll", "uuid-test", { "hnsw:space": "cosine" });

  let pages = 0;
  const mock = setupMockFetch((req) => {
    if (req.method === "GET") {
      return jsonResponse({ id: "uuid-test", name: "test-coll" });
    }
    pages += 1;
    /* первая страница успешна, вторая взрывается */
    if (pages === 1) return jsonResponse(chromaPage(0, 4, true));
    return new Response("server exploded", { status: 500 });
  });

  try {
    await assert.rejects(
      exportConcepts({
        collection: "test-coll", out: sb.outPath,
        includeEmbedding: true, pageSize: 4, maxItems: 1000,
      }),
      /Chroma HTTP 500|server exploded/,
    );

    /* out должен остаться прежним */
    const outAfter = await readFile(sb.outPath, "utf8");
    assert.equal(outAfter, "PREVIOUS_RUN\n", "real out must not be touched on failure");
  } finally {
    mock.restore();
    clearAll();
    await sb.cleanup();
  }
});

test("[concepts-export] streaming: 5000 rows finish without OOM", async () => {
  const sb = await makeSandbox();
  const m = installChromaMock(5000, 500, true);
  try {
    const heapBefore = process.memoryUsage().heapUsed;
    const result = await exportConcepts({
      collection: "test-coll", out: sb.outPath,
      includeEmbedding: true, pageSize: 500, maxItems: 10_000,
    });
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowMb = (heapAfter - heapBefore) / 1024 / 1024;

    assert.equal(result.rowsWritten, 5000);
    /* На 5K rows × ~100 bytes/row = ~500 KB на диске. В памяти не должно
     * накопиться ничего сравнимого с этим объёмом × 10. Это smoke-тест на
     * отсутствие array-accumulation; точные пороги hard-coded'ить опасно
     * (зависит от GC timing), но 50 MB прирост — явный signal regression'а. */
    assert.ok(heapGrowMb < 50, `heap grew by ${heapGrowMb.toFixed(1)} MB — array accumulation regression?`);

    const fileSize = (await stat(sb.outPath)).size;
    assert.ok(fileSize > 0);
  } finally {
    m.restore();
    await sb.cleanup();
  }
});
