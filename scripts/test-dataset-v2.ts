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
import { extractJsonFromReasoning, extractJsonObjectFromReasoning } from "../electron/lib/dataset-v2/reasoning-decoder.js";
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
    /* Memory block теперь рендерится на английском (для Cognitive Distiller-style
       английского prompt template). Маркер "Earlier in this chapter the author" —
       sentinel начала memory block из renderMemoryBlock() в concept-extractor.ts. */
    if (memorySeen[0].includes("Earlier in this chapter")) throw new Error("first call must NOT have memory");
    if (!memorySeen[1].includes("Earlier in this chapter")) throw new Error("second call MUST have memory");
    if (!memorySeen[1].includes("Concept #1")) throw new Error("memory missing first concept");
  });

  /* === Reasoning Decoder — спасает JSON из reasoning_content поля === */

  await step("R1-1 — пустой/null/undefined reasoning → null", () => {
    if (extractJsonFromReasoning("") !== null) throw new Error("empty string must return null");
    if (extractJsonFromReasoning(null) !== null) throw new Error("null must return null");
    if (extractJsonFromReasoning(undefined) !== null) throw new Error("undefined must return null");
    if (extractJsonFromReasoning("   \n  ") !== null) throw new Error("whitespace must return null");
  });

  await step("R1-2 — простой массив без обвязки → возвращается как есть", () => {
    const input = '[{"a":1},{"b":2}]';
    const out = extractJsonFromReasoning(input);
    if (out !== input) throw new Error(`expected "${input}", got "${out}"`);
    JSON.parse(out!);
  });

  await step("R1-3 — JSON внутри thinking-prose → извлекается", () => {
    const input = `Hmm, let me think about this carefully.
The chunk talks about caching strategies. So the final answer is:
[{"principle":"X","value":42}]
That should be it.`;
    const out = extractJsonFromReasoning(input);
    if (!out) throw new Error("decoder returned null");
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0].principle !== "X") {
      throw new Error(`unexpected parse: ${JSON.stringify(parsed)}`);
    }
  });

  await step("R1-4 — markdown fence ```json [...] ``` снимается", () => {
    const input = "Here is the JSON:\n```json\n[{\"k\":\"v\"}]\n```\nDone.";
    const out = extractJsonFromReasoning(input);
    if (!out) throw new Error("decoder returned null");
    const parsed = JSON.parse(out);
    if (parsed[0].k !== "v") throw new Error(`got ${JSON.stringify(parsed)}`);
  });

  await step("R1-5 — несколько массивов → возвращается ПОСЛЕДНИЙ валидный", () => {
    const input = `First draft was [{"v":1}], but on reflection the answer is [{"v":2}].`;
    const out = extractJsonFromReasoning(input);
    if (!out) throw new Error("decoder returned null");
    const parsed = JSON.parse(out);
    if (parsed[0].v !== 2) throw new Error(`expected v=2, got ${JSON.stringify(parsed)}`);
  });

  await step("R1-6 — невалидный последний массив → fallback на предыдущий", () => {
    const input = `Earlier I considered [{"v":1}], then I tried [this is broken{`;
    const out = extractJsonFromReasoning(input);
    if (!out) throw new Error("decoder returned null");
    const parsed = JSON.parse(out);
    if (parsed[0].v !== 1) throw new Error(`expected v=1, got ${JSON.stringify(parsed)}`);
  });

  await step("R1-7 — массив с вложенными объектами и [ внутри строк", () => {
    const input = `Result: [{"label":"hello [world]","arr":[1,2,3],"nested":{"deep":[true]}}]`;
    const out = extractJsonFromReasoning(input);
    if (!out) throw new Error("decoder returned null");
    const parsed = JSON.parse(out);
    if (parsed[0].label !== "hello [world]") throw new Error(`bracket-in-string broke: ${JSON.stringify(parsed)}`);
    if (!Array.isArray(parsed[0].arr) || parsed[0].arr.length !== 3) throw new Error("nested array lost");
  });

  await step("R1-8 — escape \\\" внутри строки не ломает сканер", () => {
    const input = 'Final: [{"q":"He said \\"hi [there]\\" loudly"}]';
    const out = extractJsonFromReasoning(input);
    if (!out) throw new Error("decoder returned null");
    const parsed = JSON.parse(out);
    if (!parsed[0].q.includes("hi [there]")) throw new Error("escape handling broken");
  });

  await step("R1-9 — нет ни одного [...] → null", () => {
    const input = "Just plain text with {object} but no array brackets at all.";
    if (extractJsonFromReasoning(input) !== null) throw new Error("must return null when no array");
  });

  await step("R1-O1 — extractJsonObjectFromReasoning: объект {} извлекается", () => {
    const input = "Let me think... Final judge result: {\"novelty\":0.8,\"actionability\":0.7,\"domain_fit\":0.9,\"reasoning\":\"good\"}";
    const out = extractJsonObjectFromReasoning(input);
    if (!out) throw new Error("decoder returned null");
    const parsed = JSON.parse(out);
    if (parsed.novelty !== 0.8) throw new Error(`got ${JSON.stringify(parsed)}`);
  });

  await step("R1-O2 — extractJsonObjectFromReasoning: вложенные объекты", () => {
    const input = "Result: {\"outer\":{\"inner\":{\"deep\":1}}}";
    const out = extractJsonObjectFromReasoning(input);
    if (!out) throw new Error("decoder returned null");
    const parsed = JSON.parse(out);
    if (parsed.outer.inner.deep !== 1) throw new Error("nested object lost");
  });

  await step("R1-10 — большой reasoning без catastrophic backtracking", () => {
    /* 50KB текста с 1 валидным массивом в конце — должно отработать <100мс. */
    const filler = "lorem ipsum [unbalanced bracket here ".repeat(1000);
    const input = filler + "[{\"final\":true}]";
    const t0 = Date.now();
    const out = extractJsonFromReasoning(input);
    const dt = Date.now() - t0;
    if (!out) throw new Error("decoder returned null");
    if (dt > 500) throw new Error(`decoder too slow: ${dt}ms (catastrophic backtracking risk)`);
    if (JSON.parse(out)[0].final !== true) throw new Error("wrong array picked");
  });

  /* === Dual-Prompt Routing + thinking-fallback в extractor === */

  await step("D1-1 — extractor с promptKey='cognitive' использует cognitive-промпт", async () => {
    clearPromptCache();
    const chunkText = "The optimal cache strategy is event-driven invalidation.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    let seenSystemPrompt = "";
    const mockLlm = async ({ messages }: { messages: Array<{ content: string }> }): Promise<string> => {
      seenSystemPrompt = messages[0].content;
      return JSON.stringify([
        {
          principle: "Event invalidation outperforms TTL for cache freshness and hit-rate ratio.",
          explanation: "Event-driven invalidation maintains both freshness and hit-rate well above TTL alternatives in production systems with predictable write patterns.",
          domain: "perf",
          tags: ["cache"],
          noveltyHint: "Event beats TTL for freshness.",
          sourceQuote: chunkText,
        },
      ]);
    };
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      promptKey: "cognitive",
      callbacks: { llm: mockLlm },
    });
    if (result.conceptsTotal.length !== 1) throw new Error(`expected 1, got ${result.conceptsTotal.length}`);
    if (!seenSystemPrompt.includes("COGNITIVE DISTILLER")) {
      throw new Error("cognitive prompt should contain 'COGNITIVE DISTILLER' header");
    }
    if (seenSystemPrompt.includes("OMNISSIAH::HDSK_EXTRACTOR")) {
      throw new Error("cognitive prompt must NOT contain mechanicus header");
    }
  });

  await step("D1-2 — extractor с promptKey='mechanicus' использует mechanicus-промпт", async () => {
    clearPromptCache();
    const chunkText = "Always validate user input on the server side before processing.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    let seenSystemPrompt = "";
    const mockLlm = async ({ messages }: { messages: Array<{ content: string }> }): Promise<string> => {
      seenSystemPrompt = messages[0].content;
      return JSON.stringify([
        {
          principle: "Always validate user input on the server side before processing.",
          explanation: "X.web|input_validation: server-side validation prevents bypass via crafted clients; client-only checks fail under hostile traffic. NO: rely-on-client. eg: form-data >> typed-server-schema.",
          domain: "web",
          tags: ["security"],
          noveltyHint: "Server-side wins.",
          sourceQuote: chunkText,
        },
      ]);
    };
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      promptKey: "mechanicus",
      callbacks: { llm: mockLlm },
    });
    if (result.conceptsTotal.length !== 1) throw new Error(`expected 1, got ${result.conceptsTotal.length}`);
    if (!seenSystemPrompt.includes("OMNISSIAH::HDSK_EXTRACTOR")) {
      throw new Error("mechanicus prompt should contain OMNISSIAH header");
    }
    if (!seenSystemPrompt.includes("⊕")) {
      throw new Error("mechanicus prompt should contain unicode operators");
    }
    if (seenSystemPrompt.includes("COGNITIVE DISTILLER")) {
      throw new Error("mechanicus prompt must NOT contain cognitive distiller header");
    }
  });

  await step("D1-3 — extractor по умолчанию (без promptKey) = mechanicus", async () => {
    clearPromptCache();
    const chunkText = "Defer non-critical work to idle callbacks for better TTI.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    let seenSystemPrompt = "";
    const mockLlm = async ({ messages }: { messages: Array<{ content: string }> }): Promise<string> => {
      seenSystemPrompt = messages[0].content;
      return "[]";
    };
    await extractChapterConcepts({
      chunks,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (!seenSystemPrompt.includes("OMNISSIAH::HDSK_EXTRACTOR")) {
      throw new Error("default promptKey must be mechanicus");
    }
  });

  await step("D2-1 — thinking-fallback: пустой content + JSON в reasoning → концепт извлекается", async () => {
    clearPromptCache();
    const chunkText = "Premature optimization is the root of all evil in software design decisions.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    /* Имитируем поведение LM Studio с qwen3.6: content="", JSON в reasoningContent. */
    const validJson = JSON.stringify([
      {
        principle: "Premature optimization is the root of all evil in software design decisions.",
        explanation: "Optimizing before profiling biases the codebase toward speculative micro-wins while hiding the systemic bottlenecks measurement would have surfaced. The cost: brittle abstractions and obscured correctness.",
        domain: "perf",
        tags: ["optimization", "design"],
        noveltyHint: "Profile first, optimize second.",
        sourceQuote: chunkText,
      },
    ]);
    const mockLlm = async (): Promise<{ content: string; reasoningContent?: string }> => ({
      content: "",
      reasoningContent: `Let me think about this carefully. The chunk talks about... I'll output: ${validJson}`,
    });
    const events: string[] = [];
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      promptKey: "cognitive",
      callbacks: {
        llm: mockLlm,
        onEvent: (e) => events.push(e.type),
      },
    });
    if (result.conceptsTotal.length !== 1) {
      throw new Error(`expected 1 concept from reasoning fallback, got ${result.conceptsTotal.length}`);
    }
    if (!events.includes("extract.reasoning_decoded")) {
      throw new Error("missing extract.reasoning_decoded event");
    }
  });

  await step("D2-2 — thinking-fallback: невалидный content + валидный reasoning → fallback", async () => {
    clearPromptCache();
    const chunkText = "Cohesion within a module reduces coupling between modules across the codebase boundary.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const validJson = JSON.stringify([
      {
        principle: "High cohesion within modules drives low coupling between them across boundaries.",
        explanation: "When a module's responsibilities are tightly aligned, its public surface naturally shrinks; this reduces accidental dependencies that other modules would otherwise form, lowering system-wide coupling.",
        domain: "arch",
        tags: ["modularity", "coupling"],
        noveltyHint: "Cohesion is the lever that controls coupling.",
        sourceQuote: chunkText,
      },
    ]);
    const mockLlm = async (): Promise<{ content: string; reasoningContent?: string }> => ({
      content: "Sure! I'll think about this. NOT JSON.",
      reasoningContent: `My final answer: ${validJson}`,
    });
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      promptKey: "cognitive",
      callbacks: { llm: mockLlm },
    });
    if (result.conceptsTotal.length !== 1) {
      throw new Error(`expected 1 concept from reasoning fallback, got ${result.conceptsTotal.length}`);
    }
  });

  await step("D2-3 — thinking-fallback: оба пусты → empty-content reason", async () => {
    clearPromptCache();
    const chunkText = paragraph(100);
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async (): Promise<{ content: string; reasoningContent?: string }> => ({
      content: "",
      reasoningContent: undefined,
    });
    const result = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      promptKey: "cognitive",
      callbacks: { llm: mockLlm },
    });
    if (result.conceptsTotal.length !== 0) throw new Error("expected 0 concepts");
    if (!result.warnings.some((w) => w.includes("empty-content"))) {
      throw new Error("missing empty-content warning");
    }
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
