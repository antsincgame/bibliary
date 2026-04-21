/**
 * E2E test for the Bibliary RAG pipeline.
 *
 * Pipeline under test:
 *   1. Load every JSON in `data/concepts/`, validate by Zod schema.
 *   2. Deduplicate by uuidv5(principle.toLowerCase().trim()).
 *   3. Create a dedicated Qdrant collection (default `bibliary-e2e-test`,
 *      size=384, Cosine, payload-indexes for `domain` and `tags`).
 *   4. Bulk-upsert each concept with `passage:` prefix embeddings
 *      (Xenova/multilingual-e5-small) in batches of 32.
 *   5. Run 12 representative semantic queries (10 plain + 2 with
 *      `must` filter on `domain`) and report top-3 hits per query.
 *   6. Print final summary: ingested / skipped / latencies / pass rate.
 *
 * Important: this script DOES NOT read QDRANT_COLLECTION from .env to
 * avoid clobbering production collections. Override only via
 * BIBLIARY_E2E_COLLECTION.
 *
 * Run:
 *   npx tsx scripts/e2e-rag-collection.ts
 *
 * Env:
 *   QDRANT_URL                  default http://localhost:6333
 *   BIBLIARY_E2E_COLLECTION     default bibliary-e2e-test
 *   BIBLIARY_E2E_RECREATE       "1" to drop+create even if collection exists
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { v5 as uuidv5 } from "uuid";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

import { ConceptArraySchema, type Concept } from "../src/schema.js";

const COLLECTION = process.env.BIBLIARY_E2E_COLLECTION ?? "bibliary-e2e-test";
const RECREATE = process.env.BIBLIARY_E2E_RECREATE === "1";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const VECTOR_SIZE = 384;
const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const CONCEPTS_DIR = path.resolve(process.cwd(), "data", "concepts");
const BATCH_SIZE = 32;
const MIN_PASS_RATIO = 0.7;

const qdrant = new QdrantClient({ url: QDRANT_URL });

interface CollectedConcept extends Concept {
  id: string;
  source: string;
}

interface FileResult {
  file: string;
  ok: boolean;
  count: number;
  reason?: string;
}

interface PlainQuery {
  kind: "plain";
  domainTag: string;
  text: string;
  expectAny: ReadonlyArray<string>;
}

interface FilteredQuery {
  kind: "filtered";
  domainTag: string;
  domainFilter: string;
  text: string;
  expectAny: ReadonlyArray<string>;
}

type Query = PlainQuery | FilteredQuery;

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    console.log("[embed] Loading Xenova/multilingual-e5-small …");
    extractor = await pipeline("feature-extraction", "Xenova/multilingual-e5-small");
    console.log("[embed] Model loaded.");
  }
  return extractor;
}

async function embed(text: string): Promise<number[]> {
  const model = await getExtractor();
  const out = await model(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

const embedPassage = (text: string): Promise<number[]> => embed(`passage: ${text}`);
const embedQuery = (text: string): Promise<number[]> => embed(`query: ${text}`);

function conceptId(principle: string): string {
  return uuidv5(principle.toLowerCase().trim(), NAMESPACE);
}

async function listConceptFiles(): Promise<string[]> {
  const entries = await fs.readdir(CONCEPTS_DIR);
  return entries.filter((f) => f.endsWith(".json")).sort();
}

async function loadAllConcepts(): Promise<{
  concepts: CollectedConcept[];
  files: FileResult[];
  duplicates: number;
}> {
  const files = await listConceptFiles();
  const seen = new Map<string, CollectedConcept>();
  const fileResults: FileResult[] = [];
  let duplicates = 0;

  for (const file of files) {
    const fullPath = path.join(CONCEPTS_DIR, file);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const json: unknown = JSON.parse(raw);
      const parsed = ConceptArraySchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const reason = `[${issue.path.join(".")}] ${issue.message}`;
        fileResults.push({ file, ok: false, count: 0, reason });
        continue;
      }
      let added = 0;
      for (const c of parsed.data) {
        const id = conceptId(c.principle);
        if (seen.has(id)) {
          duplicates++;
          continue;
        }
        seen.set(id, { ...c, id, source: file });
        added++;
      }
      fileResults.push({ file, ok: true, count: added });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      fileResults.push({ file, ok: false, count: 0, reason });
    }
  }
  return { concepts: Array.from(seen.values()), files: fileResults, duplicates };
}

async function ensureCollection(): Promise<{ created: boolean; recreated: boolean }> {
  const list = await qdrant.getCollections();
  const exists = list.collections.some((c) => c.name === COLLECTION);

  if (exists && RECREATE) {
    console.log(`[init] Dropping existing collection "${COLLECTION}" …`);
    await qdrant.deleteCollection(COLLECTION);
  }
  if (exists && !RECREATE) {
    return { created: false, recreated: false };
  }

  console.log(`[init] Creating collection "${COLLECTION}" (size=${VECTOR_SIZE}, Cosine) …`);
  await qdrant.createCollection(COLLECTION, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
  });
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "domain",
    field_schema: "keyword",
  });
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "tags",
    field_schema: "keyword",
  });
  return { created: !exists, recreated: exists && RECREATE };
}

async function bulkUpsert(concepts: CollectedConcept[]): Promise<{
  upserted: number;
  errors: Array<{ id: string; reason: string }>;
  msPerEmbed: number;
}> {
  let upserted = 0;
  const errors: Array<{ id: string; reason: string }> = [];
  const startEmbedTotal = Date.now();
  let embeddedCount = 0;

  for (let i = 0; i < concepts.length; i += BATCH_SIZE) {
    const slice = concepts.slice(i, i + BATCH_SIZE);
    const points: Array<{
      id: string;
      vector: number[];
      payload: Record<string, unknown>;
    }> = [];
    for (const c of slice) {
      try {
        const text = `${c.principle}. ${c.explanation}`;
        const vector = await embedPassage(text);
        embeddedCount++;
        points.push({
          id: c.id,
          vector,
          payload: {
            principle: c.principle,
            explanation: c.explanation,
            domain: c.domain,
            tags: c.tags,
            source: c.source,
          },
        });
      } catch (e) {
        errors.push({ id: c.id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    if (points.length > 0) {
      try {
        await qdrant.upsert(COLLECTION, { wait: true, points });
        upserted += points.length;
      } catch (e) {
        for (const p of points) {
          errors.push({ id: p.id, reason: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    const pct = Math.round(((i + slice.length) / concepts.length) * 100);
    process.stdout.write(`\r[ingest] ${i + slice.length}/${concepts.length} (${pct}%)        `);
  }
  process.stdout.write("\n");

  const totalEmbedMs = Date.now() - startEmbedTotal;
  const msPerEmbed = embeddedCount > 0 ? totalEmbedMs / embeddedCount : 0;
  return { upserted, errors, msPerEmbed };
}

const QUERIES: ReadonlyArray<Query> = [
  {
    kind: "plain",
    domainTag: "ux",
    text: "Как сделать кнопку очевидно кликабельной без наведения?",
    expectAny: ["clickab", "affordance", "button", "click"],
  },
  {
    kind: "plain",
    domainTag: "ux",
    text: "Закон Фиттса для мобильного интерфейса",
    expectAny: ["fitts", "tap", "target", "thumb", "size"],
  },
  {
    kind: "plain",
    domainTag: "ux",
    text: "Эвристики Якоба Нильсена для юзабилити",
    expectAny: ["nielsen", "heuristic", "usability", "consistency", "browse", "navigation"],
  },
  {
    kind: "plain",
    domainTag: "copy",
    text: "Как избавиться от штампов и канцелярита в тексте",
    expectAny: ["clich", "jargon", "stop", "bureaucr", "scan", "remove"],
  },
  {
    kind: "plain",
    domainTag: "copy",
    text: "Что такое стоп-слова и зачем их убирать",
    expectAny: ["stop-word", "stop word", "introductory", "filler", "noise", "scan"],
  },
  {
    kind: "plain",
    domainTag: "seo",
    text: "Как оптимизировать изображения для поисковиков",
    expectAny: ["image", "alt", "compress", "lazy", "seo"],
  },
  {
    kind: "plain",
    domainTag: "seo",
    text: "Что такое keyword research и intent",
    expectAny: ["keyword", "intent", "research", "search"],
  },
  {
    kind: "plain",
    domainTag: "ui",
    text: "Грид-система и колонки на лендинге",
    expectAny: ["grid", "column", "layout", "spacing"],
  },
  {
    kind: "plain",
    domainTag: "ui",
    text: "Иерархия типографики и контраст шрифтов",
    expectAny: ["typograph", "hierarch", "contrast", "font", "size"],
  },
  {
    kind: "plain",
    domainTag: "arch",
    text: "Как организовать дизайн-систему и токены",
    expectAny: ["design system", "token", "component", "library"],
  },
  {
    kind: "filtered",
    domainTag: "copy",
    domainFilter: "copy",
    text: "Как избавиться от штампов и канцелярита в тексте",
    expectAny: ["clich", "bureaucr", "stop"],
  },
  {
    kind: "filtered",
    domainTag: "copy",
    domainFilter: "copy",
    text: "Что такое стоп-слова и зачем их убирать",
    expectAny: ["stop", "filler", "noise"],
  },
];

interface SearchHit {
  id: string;
  score: number;
  principle: string;
  domain: string;
  tags: string[];
}

async function searchHits(q: Query): Promise<SearchHit[]> {
  const vector = await embedQuery(q.text);
  const filter =
    q.kind === "filtered"
      ? { must: [{ key: "domain", match: { value: q.domainFilter } }] }
      : undefined;
  const res = await qdrant.search(COLLECTION, {
    vector,
    limit: 3,
    with_payload: true,
    score_threshold: 0.1,
    ...(filter ? { filter } : {}),
  });
  return res.map((r) => ({
    id: String(r.id),
    score: r.score,
    principle: String((r.payload ?? {}).principle ?? ""),
    domain: String((r.payload ?? {}).domain ?? ""),
    tags: Array.isArray((r.payload ?? {}).tags)
      ? (((r.payload ?? {}).tags) as unknown[]).map(String)
      : [],
  }));
}

function fmtScore(s: number): string {
  return `${(s * 100).toFixed(1)}%`;
}

function shortPrinciple(s: string, max = 90): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

async function runQueries(): Promise<{
  totalMs: number;
  perQuery: Array<{
    q: Query;
    ms: number;
    hits: SearchHit[];
    matched: boolean;
    matchedKeyword?: string;
  }>;
}> {
  const perQuery: Array<{
    q: Query;
    ms: number;
    hits: SearchHit[];
    matched: boolean;
    matchedKeyword?: string;
  }> = [];
  const t0 = Date.now();
  for (const q of QUERIES) {
    const tQ = Date.now();
    const hits = await searchHits(q);
    const ms = Date.now() - tQ;
    let matched = false;
    let matchedKeyword: string | undefined;
    for (const kw of q.expectAny) {
      const needle = kw.toLowerCase();
      for (const h of hits) {
        const haystack = `${h.principle} ${h.tags.join(" ")}`.toLowerCase();
        if (haystack.includes(needle)) {
          matched = true;
          matchedKeyword = kw;
          break;
        }
      }
      if (matched) break;
    }
    perQuery.push({ q, ms, hits, matched, matchedKeyword });
  }
  return { totalMs: Date.now() - t0, perQuery };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("== Bibliary RAG E2E ==");
  console.log(`Qdrant URL : ${QDRANT_URL}`);
  console.log(`Collection : ${COLLECTION}`);
  console.log(`Recreate   : ${RECREATE ? "YES" : "no"}`);
  console.log(`Concepts   : ${CONCEPTS_DIR}`);
  console.log("");

  console.log("[step 1] Loading & validating concepts …");
  const { concepts, files, duplicates } = await loadAllConcepts();
  const okFiles = files.filter((f) => f.ok).length;
  const failedFiles = files.filter((f) => !f.ok);
  console.log(
    `         files=${files.length} ok=${okFiles} failed=${failedFiles.length} ` +
      `unique-concepts=${concepts.length} duplicates-merged=${duplicates}`
  );
  if (failedFiles.length > 0) {
    console.log("         schema failures (first 5):");
    for (const f of failedFiles.slice(0, 5)) {
      console.log(`         - ${f.file}: ${f.reason}`);
    }
  }
  if (concepts.length === 0) {
    console.error("FATAL: nothing to ingest");
    process.exit(1);
  }

  console.log("\n[step 2] Ensuring Qdrant collection …");
  const ensured = await ensureCollection();
  console.log(
    `         created=${ensured.created} recreated=${ensured.recreated} ` +
      `(size=${VECTOR_SIZE}, Cosine)`
  );

  console.log("\n[step 3] Bulk upsert (passage embeddings) …");
  const { upserted, errors, msPerEmbed } = await bulkUpsert(concepts);
  console.log(
    `         upserted=${upserted}/${concepts.length} errors=${errors.length} ` +
      `avg-embed=${msPerEmbed.toFixed(1)}ms`
  );
  if (errors.length > 0) {
    console.log("         ingest errors (first 5):");
    for (const e of errors.slice(0, 5)) console.log(`         - ${e.id}: ${e.reason}`);
  }

  console.log("\n[step 4] Verifying collection on Qdrant side …");
  const info = await qdrant.getCollection(COLLECTION);
  console.log(
    `         points_count=${info.points_count} indexed_vectors=${info.indexed_vectors_count} status=${info.status}`
  );

  console.log("\n[step 5] Running semantic queries …");
  const { totalMs: queryTotalMs, perQuery } = await runQueries();
  let matched = 0;
  for (let i = 0; i < perQuery.length; i++) {
    const r = perQuery[i];
    const verdict = r.matched ? "OK " : "??";
    const tag =
      r.q.kind === "filtered"
        ? `domain=${r.q.domainTag}, filter=${r.q.domainFilter}`
        : `domain=${r.q.domainTag}`;
    console.log(`\n  Q${i + 1} [${verdict}] (${r.ms}ms, ${tag}) ${r.q.text}`);
    if (r.matched) {
      console.log(`        matched keyword: "${r.matchedKeyword}"`);
      matched++;
    } else {
      console.log(
        `        no expected keyword in top-3 (expected any of: ${r.q.expectAny.join(", ")})`
      );
    }
    for (let j = 0; j < r.hits.length; j++) {
      const h = r.hits[j];
      console.log(
        `        ${j + 1}. ${fmtScore(h.score)} [${h.domain}] ${shortPrinciple(h.principle)}`
      );
    }
  }

  const totalMs = Date.now() - t0;
  const passRate = `${matched}/${perQuery.length}`;
  console.log("\n=== SUMMARY ===");
  console.log(`Files       : ${okFiles}/${files.length}`);
  console.log(`Ingested    : ${upserted}/${concepts.length} concepts`);
  console.log(`Errors      : ${errors.length}`);
  console.log(`Avg embed   : ${msPerEmbed.toFixed(1)}ms`);
  console.log(`Queries     : ${perQuery.length} in ${queryTotalMs}ms`);
  console.log(`Pass rate   : ${passRate} (top-3 keyword overlap)`);
  console.log(`Total       : ${totalMs}ms`);

  const minPass = Math.ceil(perQuery.length * MIN_PASS_RATIO);
  const hardFailure = errors.length > 0 || upserted < concepts.length || matched < minPass;
  process.exit(hardFailure ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error("E2E failed:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
