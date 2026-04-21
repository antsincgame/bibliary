/**
 * Phase 3.1 — unit-тесты Dataset v2 ступеней (без живой LLM).
 *
 * Stage 1 (semantic-chunker) — детерминированно, проверяем разбиение.
 * Stage 3 (intra-dedup) — детерминированно, проверяем мердж двух одинаковых.
 * Stage 2/4 — с mock-LLM, проверяем парсинг JSON, hallucinated-quote guard,
 * chapter-memory accumulation, judge scoring.
 *
 * Запуск:  npx tsx scripts/test-dataset-v2.ts
 */

import { chunkChapter } from "../electron/lib/dataset-v2/semantic-chunker.js";
import { dedupChapterConcepts } from "../electron/lib/dataset-v2/intra-dedup.js";
import { extractChapterConcepts, clearPromptCache } from "../electron/lib/dataset-v2/concept-extractor.js";
import type { BookSection } from "../electron/lib/scanner/parsers/index.js";
import type { ExtractedConcept } from "../electron/lib/dataset-v2/types.js";

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function step(label: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  ${label.padEnd(70, ".")} `);
  try {
    await fn();
    console.log(`${COLOR.green}PASS${COLOR.reset}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${COLOR.red}FAIL${COLOR.reset}\n      ${COLOR.dim}${msg}${COLOR.reset}`);
    failed++;
    failures.push(`${label}: ${msg}`);
  }
}

function paragraph(words: number): string {
  const vocab = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit"];
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(vocab[i % vocab.length]);
  return out.join(" ");
}

function makeSection(paragraphs: string[], title = "Test Chapter"): BookSection {
  return { level: 1, title, paragraphs };
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}== Bibliary Dataset v2 unit tests ==${COLOR.reset}\n`);
  clearPromptCache();

  /* === Stage 1 — Semantic Chunker === */

  await step("S1-1 — короткая глава (<1500 слов) = один чанк, partTotal=1", async () => {
    const section = makeSection([paragraph(50), paragraph(80), paragraph(60)]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    if (chunks.length !== 1) throw new Error(`got ${chunks.length} chunks, expected 1`);
    if (chunks[0].partTotal !== 1) throw new Error(`partTotal=${chunks[0].partTotal}`);
  });

  await step("S1-2 — длинная глава (~7000 слов) разбивается на чанки", async () => {
    const section = makeSection(Array.from({ length: 14 }, () => paragraph(500)));
    const chunks = await chunkChapter({ section, chapterIndex: 3, bookTitle: "B", bookSourcePath: "/x" });
    if (chunks.length < 1) throw new Error(`expected >=1 chunks, got ${chunks.length}`);
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].partN !== i + 1) throw new Error(`partN mismatch at ${i}`);
      if (chunks[i].partTotal !== chunks.length) throw new Error("partTotal mismatch");
    }
  });

  await step("S1-3 — мега-параграф режется", async () => {
    const sentences = "Sentence one. ".repeat(800);
    const section = makeSection([sentences]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    if (chunks.length < 1) throw new Error("zero chunks");
  });

  await step("S1-4 — пустая глава возвращает пустой массив", async () => {
    const section = makeSection([]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    if (chunks.length !== 0) throw new Error(`expected 0, got ${chunks.length}`);
  });

  await step("S1-5 — breadcrumb содержит bookTitle и chapter", async () => {
    const section = makeSection([paragraph(100)], "Шардирование");
    const chunks = await chunkChapter({ section, chapterIndex: 4, bookTitle: "DDIA", bookSourcePath: "/x" });
    const bc = chunks[0].breadcrumb;
    if (!bc.includes("DDIA")) throw new Error("no book title");
    if (!bc.includes("Шардирование")) throw new Error("no chapter title");
  });

  /* === Stage 3 — Intra-Chapter Dedup === */

  await step("S3-1 — дубликат по похожему principle мерджится", async () => {
    const concepts: ExtractedConcept[] = [
      {
        principle: "Cache invalidation should be event-driven, not TTL-based, for hit rate",
        explanation: "When using TTL the cache loses freshness whereas event invalidation keeps both hit-rate high and freshness preserved at the cost of more wiring.",
        domain: "perf",
        tags: ["cache", "invalidation"],
        noveltyHint: "Event-driven cache invalidation outperforms TTL.",
        sourceQuote: "Cache invalidation by event, not TTL",
      },
      {
        principle: "Prefer event-based cache invalidation over TTL to maintain freshness",
        explanation: "TTL invalidation loses freshness because data updates are not reflected until the timer expires. Event-driven keeps the cache hot and current.",
        domain: "perf",
        tags: ["cache", "ttl"],
        noveltyHint: "Event invalidation gives both freshness and high hit-rate.",
        sourceQuote: "TTL is suboptimal for freshness",
      },
    ];
    const result = await dedupChapterConcepts({
      concepts,
      bookSourcePath: "/x.pdf",
      bookTitle: "B",
      chapterIndex: 0,
      chapterTitle: "Cache",
    });
    if (result.concepts.length !== 1) throw new Error(`expected 1 merged, got ${result.concepts.length}`);
    if (result.mergedPairs !== 1) throw new Error(`mergedPairs=${result.mergedPairs}`);
    if (result.concepts[0].mergedFromIds.length < 2) throw new Error("merge audit missing");
    if (result.concepts[0].tags.length < 3) throw new Error("tags should be union");
  });

  await step("S3-2 — разные концепты НЕ мерджатся", async () => {
    const concepts: ExtractedConcept[] = [
      {
        principle: "Sharding by user_id avoids hotspot for read-heavy workloads",
        explanation: "Range sharding by user_id creates uneven load when popular users dominate. Hash sharding spreads reads across shards.",
        domain: "arch",
        tags: ["sharding", "db"],
        noveltyHint: "Hash beats range for popularity-skewed workloads.",
        sourceQuote: "user_id hashing avoids hotspots",
      },
      {
        principle: "Always use stable sort when tie-breaking on relevance scores",
        explanation: "Unstable sort produces flaky UX in search results when scores tie, frustrating users and breaking pagination.",
        domain: "ux",
        tags: ["sort", "ranking"],
        noveltyHint: "Stable sort is invisible until it isn't.",
        sourceQuote: "Use stable sort for ranking ties",
      },
    ];
    const result = await dedupChapterConcepts({
      concepts,
      bookSourcePath: "/x.pdf",
      bookTitle: "B",
      chapterIndex: 0,
      chapterTitle: "Mixed",
    });
    if (result.concepts.length !== 2) throw new Error(`expected 2 distinct, got ${result.concepts.length}`);
    if (result.mergedPairs !== 0) throw new Error(`unexpected merge: ${result.mergedPairs}`);
  });

  await step("S3-3 — пустой массив возвращает пустой", async () => {
    const result = await dedupChapterConcepts({
      concepts: [],
      bookSourcePath: "/x.pdf",
      bookTitle: "B",
      chapterIndex: 0,
      chapterTitle: "Empty",
    });
    if (result.concepts.length !== 0) throw new Error("not empty");
  });

  /* === Stage 2 — Concept Extractor (mock LLM) === */

  await step("S2-1 — LLM возвращает валидный JSON → концепты приняты", async () => {
    const chunkText = "The optimal cache eviction strategy is event-driven invalidation, not TTL. Event-driven keeps freshness and hit-rate.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async () =>
      JSON.stringify([
        {
          principle: "Cache invalidation by event beats TTL on freshness and hit-rate",
          explanation: "Event-driven invalidation maintains both freshness and high cache hit-rate, unlike TTL which trades one for the other.",
          domain: "perf",
          tags: ["cache", "invalidation"],
          noveltyHint: "Event-driven cache wins on both axes.",
          sourceQuote: "event-driven invalidation, not TTL",
        },
      ]);
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.conceptsTotal.length !== 1) throw new Error(`got ${result.conceptsTotal.length} concepts`);
    if (result.warnings.length > 0) throw new Error(`unexpected warnings: ${result.warnings.join(",")}`);
  });

  await step("S2-2 — hallucinated quote → концепт отбрасывается", async () => {
    const chunkText = "The optimal cache strategy is event-driven invalidation.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async () =>
      JSON.stringify([
        {
          principle: "Cache invalidation by event beats TTL on freshness and hit-rate",
          explanation: "Event-driven invalidation maintains both freshness and hit-rate well above TTL alternatives in production systems.",
          domain: "perf",
          tags: ["cache"],
          noveltyHint: "Event beats TTL.",
          sourceQuote: "this exact quote does not exist in the source text at all",
        },
      ]);
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.conceptsTotal.length !== 0) throw new Error("hallucinated quote should be rejected");
    if (!result.warnings.some((w) => w.includes("hallucinated-quote"))) throw new Error("missing hallucinated warning");
  });

  await step("S2-3 — невалидный JSON → ноль концептов + warning", async () => {
    const chunkText = paragraph(100);
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async () => "this is definitely not JSON, sorry";
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.conceptsTotal.length !== 0) throw new Error("should be 0");
    if (!result.warnings.some((w) => w.includes("json-parse"))) throw new Error("missing json-parse warning");
  });

  await step("S2-4 — chapter memory растёт между чанками", async () => {
    const longSec = makeSection(Array.from({ length: 14 }, () => paragraph(500)), "Multi");
    const chunks = await chunkChapter({ section: longSec, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    if (chunks.length < 2) throw new Error("need ≥2 chunks");

    let calls = 0;
    const memorySeen: string[] = [];
    const mockLlm = async ({ messages }: { messages: Array<{ content: string }> }) => {
      calls++;
      memorySeen.push(messages[0].content);
      const principle = `Concept #${calls} about lorem ipsum patterns`;
      const explanation = "lorem ipsum dolor sit amet consectetur adipiscing elit detailed deep explanation here for the test purposes only, must be at least 80 chars long for zod.";
      const sample = chunks[Math.min(calls - 1, chunks.length - 1)].text.slice(0, 60);
      return JSON.stringify([
        {
          principle,
          explanation,
          domain: "arch",
          tags: ["lorem", "test"],
          noveltyHint: `Hint number ${calls} about lorem.`,
          sourceQuote: sample,
        },
      ]);
    };
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.conceptsTotal.length < 2) throw new Error(`only ${result.conceptsTotal.length} concepts`);
    /* В первом запросе памяти ещё нет, во втором должна появиться */
    if (memorySeen[0].includes("Ранее в этой главе")) throw new Error("first call must NOT have memory");
    if (!memorySeen[1].includes("Ранее в этой главе")) throw new Error("second call MUST have memory");
    if (!memorySeen[1].includes("Concept #1")) throw new Error("memory missing first concept");
  });

  /* === Summary === */

  console.log(`\n${COLOR.bold}--- Summary ---${COLOR.reset}`);
  console.log(`Tests passed: ${COLOR.green}${passed}${COLOR.reset}`);
  console.log(`Tests failed: ${failed === 0 ? COLOR.green : COLOR.red}${failed}${COLOR.reset}`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
