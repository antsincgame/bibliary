/**
 * Bibliary Hybrid Retrieval Benchmark Runner.
 *
 * Запускает 50-query benchmark на ЖИВОЙ инфраструктуре (Qdrant + E5):
 *
 *   1. Создаёт временную коллекцию (опционально hybrid с sparse vectors).
 *   2. Индексирует 38 chunks из `tests/fixtures/hybrid-search-benchmark.ts`.
 *   3. Прогоняет 50 queries × 3 стратегии:
 *        a) dense-only (`searchRelevantChunks` без rerank)
 *        b) dense + cross-encoder rerank (текущий прод)
 *        c) hybrid (BM25 + dense + RRF + rerank) — если коллекция hybrid
 *   4. Считает метрики: Recall@5, Recall@10, MRR, nDCG@10.
 *   5. Печатает таблицу + сохраняет JSON в `data/benchmarks/hybrid-{ts}.json`.
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   $ npx tsx scripts/run-hybrid-bench.ts                       # все 3 стратегии
 *   $ npx tsx scripts/run-hybrid-bench.ts --strategies=dense    # только dense
 *   $ npx tsx scripts/run-hybrid-bench.ts --keep-collection     # не удалять после
 *   $ QDRANT_URL=http://localhost:6333 BIBLIARY_DATA_DIR=./tmp \
 *     npx tsx scripts/run-hybrid-bench.ts
 *
 * ТРЕБОВАНИЯ:
 *   - Qdrant запущен (по умолчанию http://localhost:6333)
 *   - E5 model (Xenova/multilingual-e5-small) — скачается автоматически
 *   - BGE reranker (Xenova/bge-reranker-large) — скачается автоматически (~280 MB)
 *   - Если запускается hybrid: Qdrant 1.10+ с поддержкой sparse vectors
 *
 * ЗАМЕТКА: первый запуск качает ONNX модели — ожидайте 1-3 мин cold start.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

import {
  BENCHMARK_CORPUS,
  BENCHMARK_QUERIES,
  selfCheckBenchmark,
  type BenchmarkChunk,
  type BenchmarkQuery,
} from "../tests/fixtures/hybrid-search-benchmark.js";
import { embedPassage, embedQuery } from "../electron/lib/embedder/shared.js";
import { ensureQdrantCollection } from "../electron/lib/qdrant/collection-config.js";
import { fetchQdrantJson, QDRANT_URL } from "../electron/lib/qdrant/http-client.js";
import { bm25SparseVector } from "../electron/lib/qdrant/bm25-sparse.js";
import { searchRelevantChunks, embedQuery as ragEmbedQuery } from "../electron/lib/rag/index.js";
import { searchHybridChunks } from "../electron/lib/rag/hybrid-search.js";
import { rerankPassages } from "../electron/lib/rag/reranker.js";

/* ─── CLI args ──────────────────────────────────────────────────────── */

const ARGS = parseArgs(process.argv.slice(2));

interface CliArgs {
  strategies: Array<"dense-only" | "dense+rerank" | "hybrid">;
  keepCollection: boolean;
  topK: number;
  collectionPrefix: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    strategies: ["dense-only", "dense+rerank", "hybrid"],
    keepCollection: false,
    topK: 15,
    collectionPrefix: "bench",
  };
  for (const a of argv) {
    if (a.startsWith("--strategies=")) {
      const list = a.slice("--strategies=".length).split(",").map((s) => s.trim());
      const valid = list.filter((s): s is CliArgs["strategies"][number] =>
        s === "dense-only" || s === "dense+rerank" || s === "hybrid",
      );
      if (valid.length > 0) out.strategies = valid;
    } else if (a === "--keep-collection") {
      out.keepCollection = true;
    } else if (a.startsWith("--top-k=")) {
      const n = Number(a.slice("--top-k=".length));
      if (Number.isFinite(n) && n > 0) out.topK = n;
    } else if (a.startsWith("--prefix=")) {
      out.collectionPrefix = a.slice("--prefix=".length);
    }
  }
  return out;
}

/* ─── Метрики ───────────────────────────────────────────────────────── */

interface QueryEval {
  queryId: string;
  query: string;
  queryType: string;
  expectedWinner: string;
  relevant: Set<string>;
  retrieved: string[]; /* IDs in rank order */
  retrievedRanks: Map<string, number>; /* id → rank (0-based) */
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  latencyMs: number;
}

interface StrategyResult {
  strategy: string;
  queries: QueryEval[];
  meanRecallAt5: number;
  meanRecallAt10: number;
  meanMRR: number;
  meanNdcgAt10: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  byQueryType: Record<string, { count: number; recallAt5: number; recallAt10: number }>;
}

function computeRecall(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = retrieved.slice(0, k);
  let hits = 0;
  for (const r of top) if (relevant.has(r)) hits += 1;
  return hits / relevant.size;
}

function computeMRR(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function computeNDCG(retrieved: string[], relevant: Set<string>, k: number): number {
  /* Бинарная релевантность (rel = 1 если в relevant set, иначе 0).
     DCG = sum_{i=0..k-1} rel_i / log2(i+2)
     idealDCG = sum_{i=0..min(|relevant|, k)-1} 1 / log2(i+2) */
  let dcg = 0;
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (relevant.has(retrieved[i]!)) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  let idealDcg = 0;
  for (let i = 0; i < Math.min(relevant.size, k); i++) {
    idealDcg += 1 / Math.log2(i + 2);
  }
  return idealDcg > 0 ? dcg / idealDcg : 0;
}

/* ─── Strategies ────────────────────────────────────────────────────── */

interface RetrievalFn {
  (collection: string, query: string, topK: number): Promise<Array<{ id: string; score: number }>>;
}

const strategies: Record<CliArgs["strategies"][number], RetrievalFn> = {
  /* Pure dense через embedQuery + Qdrant search (БЕЗ rerank).
     Используем сырой fetch чтобы обойти rerank в searchRelevantChunks. */
  "dense-only": async (collection, query, topK) => {
    const vector = await embedQuery(query);
    const data = await fetchQdrantJson<{
      result: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>;
    }>(`${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: { name: "dense", vector }, /* named vector — для hybrid коллекций */
        limit: topK,
        with_payload: false,
      }),
      timeoutMs: 15_000,
    }).catch(async () => {
      /* Fallback: коллекция без named vectors. */
      const v = await embedQuery(query);
      return fetchQdrantJson<{
        result: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>;
      }>(`${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vector: v, limit: topK, with_payload: false }),
        timeoutMs: 15_000,
      });
    });
    return (data.result ?? []).map((p) => ({ id: String(p.id), score: p.score }));
  },

  /* Dense + rerank: вызываем production searchRelevantChunks. */
  "dense+rerank": async (collection, query, topK) => {
    const r = await searchRelevantChunks(collection, query, topK, 0, 30_000);
    return r.map((p) => ({ id: p.id, score: p.score }));
  },

  /* Hybrid: dense + sparse + RRF + rerank. */
  hybrid: async (collection, query, topK) => {
    const r = await searchHybridChunks(collection, query, topK, 30_000);
    return r.map((p) => ({ id: p.id, score: p.rerankScore ?? p.score }));
  },
};

/* ─── Indexing ──────────────────────────────────────────────────────── */

async function setupCollection(name: string, hybrid: boolean): Promise<void> {
  console.log(`[bench] creating collection "${name}" (hybrid=${hybrid})`);
  await ensureQdrantCollection({
    name,
    vectorSize: 384,
    sparseVectors: hybrid,
    hnsw: { m: 24, ef_construct: 128 },
    payloadIndexes: [{ field: "topic", type: "keyword" }],
  });

  console.log(`[bench] indexing ${BENCHMARK_CORPUS.length} chunks...`);
  let indexed = 0;
  for (const chunk of BENCHMARK_CORPUS) {
    const dense = await embedPassage(chunk.text);
    const point: Record<string, unknown> = {
      id: deterministicPointId(chunk.id),
      payload: { text: chunk.text, topic: chunk.topic, language: chunk.language, originalId: chunk.id },
    };
    if (hybrid) {
      const sparse = bm25SparseVector(chunk.text);
      point.vector = {
        dense,
        bm25: { indices: sparse.indices, values: sparse.values },
      };
    } else {
      point.vector = dense;
    }
    await fetchQdrantJson<{ result: unknown }>(
      `${QDRANT_URL}/collections/${encodeURIComponent(name)}/points?wait=true`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: [point] }),
        timeoutMs: 30_000,
      },
    );
    indexed += 1;
    if (indexed % 10 === 0) {
      process.stdout.write(`  ${indexed}/${BENCHMARK_CORPUS.length}\r`);
    }
  }
  process.stdout.write(`  ${indexed}/${BENCHMARK_CORPUS.length} ✓\n`);
}

/** Детерминированный UUID-ish из chunk.id (sha1 → 32 hex → 8-4-4-4-12). */
function deterministicPointId(rawId: string): string {
  const hex = createHash("sha1").update(rawId).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/* ─── Mapping pointId → originalId ──────────────────────────────────── */

const idMap = new Map<string, string>();
for (const c of BENCHMARK_CORPUS) idMap.set(deterministicPointId(c.id), c.id);

function pointIdToOriginal(pointId: string): string {
  return idMap.get(pointId) ?? pointId;
}

/* ─── Eval one strategy ─────────────────────────────────────────────── */

async function runStrategy(
  strategyName: CliArgs["strategies"][number],
  collection: string,
  topK: number,
): Promise<StrategyResult> {
  const fn = strategies[strategyName];
  const queries: QueryEval[] = [];

  for (const q of BENCHMARK_QUERIES) {
    const relevant = new Set(q.relevantChunkIds);
    const startedAt = Date.now();
    let rawRetrieved: Array<{ id: string }> = [];
    try {
      rawRetrieved = await fn(collection, q.query, Math.max(topK, 10));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bench/${strategyName}] query ${q.id} failed: ${msg.slice(0, 200)}`);
    }
    const latencyMs = Date.now() - startedAt;

    /* Mapping point IDs → original chunk IDs. */
    const retrieved = rawRetrieved.map((r) => pointIdToOriginal(r.id));
    const retrievedRanks = new Map<string, number>();
    retrieved.forEach((id, i) => retrievedRanks.set(id, i));

    queries.push({
      queryId: q.id,
      query: q.query,
      queryType: q.queryType,
      expectedWinner: q.expectedWinner,
      relevant,
      retrieved,
      retrievedRanks,
      recallAt5: computeRecall(retrieved, relevant, 5),
      recallAt10: computeRecall(retrieved, relevant, 10),
      mrr: computeMRR(retrieved, relevant),
      ndcgAt10: computeNDCG(retrieved, relevant, 10),
      latencyMs,
    });
  }

  /* Aggregate. */
  const totalLatency = queries.reduce((s, q) => s + q.latencyMs, 0);
  const byQueryType: StrategyResult["byQueryType"] = {};
  for (const q of queries) {
    if (!byQueryType[q.queryType]) {
      byQueryType[q.queryType] = { count: 0, recallAt5: 0, recallAt10: 0 };
    }
    byQueryType[q.queryType]!.count += 1;
    byQueryType[q.queryType]!.recallAt5 += q.recallAt5;
    byQueryType[q.queryType]!.recallAt10 += q.recallAt10;
  }
  for (const t of Object.keys(byQueryType)) {
    byQueryType[t]!.recallAt5 /= byQueryType[t]!.count;
    byQueryType[t]!.recallAt10 /= byQueryType[t]!.count;
  }

  return {
    strategy: strategyName,
    queries,
    meanRecallAt5: queries.reduce((s, q) => s + q.recallAt5, 0) / queries.length,
    meanRecallAt10: queries.reduce((s, q) => s + q.recallAt10, 0) / queries.length,
    meanMRR: queries.reduce((s, q) => s + q.mrr, 0) / queries.length,
    meanNdcgAt10: queries.reduce((s, q) => s + q.ndcgAt10, 0) / queries.length,
    totalLatencyMs: totalLatency,
    meanLatencyMs: totalLatency / queries.length,
    byQueryType,
  };
}

/* ─── Output ────────────────────────────────────────────────────────── */

function formatPercent(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

function printResults(results: StrategyResult[]): void {
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("📊 RESULTS");
  console.log("══════════════════════════════════════════════════════════════════\n");

  /* Aggregate table. */
  console.log("Strategy        | Recall@5 | Recall@10 | MRR    | nDCG@10 | Latency (mean ms)");
  console.log("----------------|----------|-----------|--------|---------|------------------");
  for (const r of results) {
    const name = r.strategy.padEnd(15);
    const r5 = formatPercent(r.meanRecallAt5).padStart(8);
    const r10 = formatPercent(r.meanRecallAt10).padStart(9);
    const mrr = r.meanMRR.toFixed(3).padStart(6);
    const ndcg = r.meanNdcgAt10.toFixed(3).padStart(7);
    const lat = r.meanLatencyMs.toFixed(0).padStart(16);
    console.log(`${name} | ${r5} | ${r10} | ${mrr} | ${ndcg} | ${lat}`);
  }

  /* By query type. */
  console.log("\n📋 BREAKDOWN BY QUERY TYPE\n");
  const queryTypes = new Set<string>();
  for (const r of results) for (const t of Object.keys(r.byQueryType)) queryTypes.add(t);
  const sortedTypes = [...queryTypes].sort();

  let header = "Query Type     | Count |";
  for (const r of results) header += ` ${r.strategy.padStart(13)} R@5 |`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const t of sortedTypes) {
    let row = `${t.padEnd(14)} | ${String(results[0]!.byQueryType[t]?.count ?? 0).padStart(5)} |`;
    for (const r of results) {
      const r5 = r.byQueryType[t] ? formatPercent(r.byQueryType[t]!.recallAt5) : "—";
      row += ` ${r5.padStart(17)} |`;
    }
    console.log(row);
  }

  /* Improvement pairs. */
  if (results.length >= 2) {
    console.log("\n📈 PAIRWISE IMPROVEMENT\n");
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i]!;
        const b = results[j]!;
        const dr5 = (b.meanRecallAt5 - a.meanRecallAt5) / Math.max(0.001, a.meanRecallAt5);
        const dr10 = (b.meanRecallAt10 - a.meanRecallAt10) / Math.max(0.001, a.meanRecallAt10);
        const dMRR = (b.meanMRR - a.meanMRR) / Math.max(0.001, a.meanMRR);
        console.log(
          `${b.strategy} vs ${a.strategy}: Recall@5 ${dr5 >= 0 ? "+" : ""}${(dr5 * 100).toFixed(1)}%, Recall@10 ${dr10 >= 0 ? "+" : ""}${(dr10 * 100).toFixed(1)}%, MRR ${dMRR >= 0 ? "+" : ""}${(dMRR * 100).toFixed(1)}%`,
        );
      }
    }
  }

  console.log("\n══════════════════════════════════════════════════════════════════\n");
}

async function saveJsonReport(results: StrategyResult[]): Promise<string> {
  const dataDir = process.env.BIBLIARY_DATA_DIR ?? path.join(process.cwd(), "data");
  const outDir = path.join(dataDir, "benchmarks");
  await fs.mkdir(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fp = path.join(outDir, `hybrid-${ts}.json`);
  /* Не сохраняем queries.relevant (Set) и retrievedRanks (Map) — они не JSON-serializable. */
  const serializable = results.map((r) => ({
    strategy: r.strategy,
    meanRecallAt5: r.meanRecallAt5,
    meanRecallAt10: r.meanRecallAt10,
    meanMRR: r.meanMRR,
    meanNdcgAt10: r.meanNdcgAt10,
    meanLatencyMs: r.meanLatencyMs,
    totalLatencyMs: r.totalLatencyMs,
    byQueryType: r.byQueryType,
    queries: r.queries.map((q) => ({
      queryId: q.queryId,
      query: q.query,
      queryType: q.queryType,
      expectedWinner: q.expectedWinner,
      relevant: [...q.relevant],
      retrieved: q.retrieved.slice(0, 15),
      recallAt5: q.recallAt5,
      recallAt10: q.recallAt10,
      mrr: q.mrr,
      ndcgAt10: q.ndcgAt10,
      latencyMs: q.latencyMs,
    })),
  }));
  await fs.writeFile(fp, JSON.stringify({ ranAt: new Date().toISOString(), results: serializable }, null, 2));
  return fp;
}

/* ─── Main ──────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log("🔬 Bibliary Hybrid Retrieval Benchmark\n");

  /* Self-check датасета. */
  const check = selfCheckBenchmark();
  if (check.brokenQueries.length > 0) {
    console.error("❌ Benchmark dataset is broken:");
    for (const b of check.brokenQueries) console.error(`   ${b}`);
    process.exit(1);
  }
  console.log(`✓ Dataset OK: ${check.totalQueries} queries × ${check.totalChunks} chunks`);
  console.log(`  By type: ${JSON.stringify(check.byQueryType)}`);
  console.log(`  Strategies to run: ${ARGS.strategies.join(", ")}\n`);

  const sessionId = randomUUID().slice(0, 8);

  /* Hybrid стратегия требует hybrid коллекции. dense-only и dense+rerank
     работают на той же коллекции (hybrid поддерживает named vector "dense"). */
  const needsHybrid = ARGS.strategies.includes("hybrid");
  const collection = `${ARGS.collectionPrefix}-${sessionId}`;

  let results: StrategyResult[] = [];

  try {
    await setupCollection(collection, needsHybrid);

    for (const strategy of ARGS.strategies) {
      console.log(`\n▶ Running strategy: ${strategy}`);
      const startedAt = Date.now();
      const r = await runStrategy(strategy, collection, ARGS.topK);
      const elapsed = Date.now() - startedAt;
      console.log(
        `  Done in ${elapsed}ms: Recall@5=${formatPercent(r.meanRecallAt5)}, Recall@10=${formatPercent(r.meanRecallAt10)}, MRR=${r.meanMRR.toFixed(3)}`,
      );
      results.push(r);
    }

    printResults(results);

    const reportPath = await saveJsonReport(results);
    console.log(`📁 Report saved: ${reportPath}\n`);
  } finally {
    if (!ARGS.keepCollection) {
      try {
        await fetchQdrantJson<{ result: unknown }>(
          `${QDRANT_URL}/collections/${encodeURIComponent(collection)}`,
          { method: "DELETE", timeoutMs: 10_000 },
        );
        console.log(`🗑  Cleanup: deleted collection "${collection}"`);
      } catch (e) {
        console.warn(`Cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.log(`📌 Collection "${collection}" kept (--keep-collection)`);
    }
  }
}

void main().catch((e) => {
  console.error("❌ Bench failed:", e);
  process.exit(1);
});

/* Suppress "unused import" lint when ragEmbedQuery is not directly used. */
void ragEmbedQuery;
void rerankPassages;
