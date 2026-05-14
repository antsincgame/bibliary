/**
 * Phase 3.1 — unit-тесты Dataset v2 ступеней (без живой LLM).
 *
 * Stage 1 (semantic-chunker) — детерминированно.
 * Stage 2 (delta-extractor) — с mock-LLM: JSON → DeltaKnowledge, AURA/null, zod.
 * Reasoning decoder — детерминированно.
 *
 * Запуск:  npx tsx scripts/test-dataset-v2.ts
 */

import { chunkChapter } from "../electron/lib/dataset-v2/semantic-chunker.js";
import { extractDeltaKnowledge, clearPromptCache } from "../electron/lib/dataset-v2/delta-extractor.js";
import { extractJsonFromReasoning, extractJsonObjectFromReasoning } from "../electron/lib/dataset-v2/reasoning-decoder.js";
import { isNonContentSection } from "../electron/lib/dataset-v2/section-filter.js";
import type { BookSection } from "../server/lib/scanner/parsers/index.js";

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

/** Минимально валидный объект DeltaKnowledge для mock-LLM. */
function mockDeltaPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domain: "perf",
    chapterContext: "This chapter explains cache strategies for production systems and workloads.",
    essence:
      "Event-driven cache invalidation keeps freshness and hit rate higher than TTL-only policies in write-heavy workloads.",
    cipher: "X >> cache + event > TTL ^ freshness",
    proof:
      "TTL delays visibility of updates until expiry; events propagate invalidation immediately when data changes, measured in tests as higher hit rate.",
    applicability: "Prefer domain events for cache busting on user-visible entities.",
    auraFlags: ["authorship", "specialization"],
    tags: ["cache", "invalidation"],
    relations: [
      { subject: "cache", predicate: "invalidated_by", object: "domain_event" },
      { subject: "TTL_policy", predicate: "lags_behind", object: "event_driven_invalidation" },
    ],
    ...overrides,
  };
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
    /* Без e5/sharp в окружении: отключаем drift-эмбеддинги (жёсткая нарезка по лимиту). */
    const chunks = await chunkChapter({
      section,
      chapterIndex: 3,
      bookTitle: "B",
      bookSourcePath: "/x",
      maxParagraphsForDrift: 0,
    });
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

  await step("S1-6 — служебные разделы Contents/About Authors отбрасываются", () => {
    if (!isNonContentSection(makeSection([paragraph(100)], "Table of Contents"))) {
      throw new Error("Table of Contents was not detected");
    }
    if (!isNonContentSection(makeSection([paragraph(100)], "Об авторах"))) {
      throw new Error("Об авторах was not detected");
    }
    if (!isNonContentSection(makeSection([paragraph(100)], "About the Technical Reviewer"))) {
      throw new Error("About the Technical Reviewer was not detected");
    }
    if (!isNonContentSection(makeSection([paragraph(100)], "Краткое содержание"))) {
      throw new Error("Краткое содержание was not detected");
    }
    if (!isNonContentSection(makeSection([paragraph(100)], "Conventions Used in This Book"))) {
      throw new Error("Conventions Used in This Book was not detected");
    }
    if (!isNonContentSection(makeSection([paragraph(100)], "ISBN 978-5-9775-2062-1"))) {
      throw new Error("ISBN metadata section was not detected");
    }
    if (isNonContentSection(makeSection([paragraph(100)], "Cache Invalidation Strategies"))) {
      throw new Error("real chapter falsely detected as non-content");
    }
  });

  await step("S1-7 — мелкие structural blocks склеиваются до рабочих чанков", async () => {
    const paragraphs = [
      "## Topic A",
      paragraph(120),
      "## Topic B",
      paragraph(120),
      "## Topic C",
      paragraph(120),
    ];
    const chunks = await chunkChapter({
      section: makeSection(paragraphs, "Small Blocks"),
      chapterIndex: 0,
      bookTitle: "B",
      bookSourcePath: "/x",
      maxParagraphsForDrift: 0,
    });
    if (chunks.length !== 1) throw new Error(`expected merged 1 chunk, got ${chunks.length}`);
    if (chunks[0].wordCount < 300) throw new Error(`merged chunk too small: ${chunks[0].wordCount}`);
  });

  /* === Stage 2 — Delta Extractor (mock LLM) === */

  const thesis = "The chapter argues for pragmatic cache invalidation strategies.";

  await step("S2-1 — LLM возвращает валидный JSON → одна DeltaKnowledge", async () => {
    const chunkText =
      "The optimal cache eviction strategy is event-driven invalidation, not TTL. Event-driven keeps freshness and hit-rate.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async () => JSON.stringify(mockDeltaPayload());
    const result = await extractDeltaKnowledge({
      chunks,
      chapterThesis: thesis,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.accepted.length !== 1) throw new Error(`got ${result.accepted.length} accepted`);
    if (result.warnings.length > 0) throw new Error(`unexpected warnings: ${result.warnings.join(",")}`);
  });

  await step("S2-2 — zod: слишком короткая essence → отбрасывается", async () => {
    const chunkText = "The optimal cache strategy is event-driven invalidation.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async () =>
      JSON.stringify(
        mockDeltaPayload({
          essence: "short",
        }),
      );
    const result = await extractDeltaKnowledge({
      chunks,
      chapterThesis: thesis,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.accepted.length !== 0) throw new Error("short essence should be rejected");
    if (!result.warnings.some((w) => w.includes("zod"))) throw new Error("missing zod warning");
  });

  await step("S2-3 — невалидный JSON → ноль accepted + warning", async () => {
    const chunkText = paragraph(100);
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async () => "this is definitely not JSON, sorry";
    const result = await extractDeltaKnowledge({
      chunks,
      chapterThesis: thesis,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.accepted.length !== 0) throw new Error("should be 0");
    if (!result.warnings.some((w) => w.includes("attempt-1") || w.includes("attempt-2"))) {
      throw new Error("missing parse attempt warnings");
    }
  });

  await step("S2-3b — маркетинговый/библиографический шум не принимается", async () => {
    const section = makeSection([paragraph(120)]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async () => JSON.stringify(mockDeltaPayload({
      domain: "other",
      chapterContext: "This section contains book endorsements and bibliographic metadata only.",
      essence: "The provided text is a bibliographic description and marketing endorsement rather than a technical mechanism.",
      proof: "It lists praise, publication context, and promotional claims without a causal technical model.",
      tags: ["endorsement", "marketing"],
    }));
    const result = await extractDeltaKnowledge({
      chunks,
      chapterThesis: thesis,
      callbacks: { llm: mockLlm },
    });
    if (result.accepted.length !== 0) throw new Error(`expected 0 accepted, got ${result.accepted.length}`);
    if (!result.warnings.some((w) => w.includes("meta-noise"))) throw new Error("expected meta-noise warning");
  });

  await step("S2-4 — chapter memory растёт между чанками (overlap выключен)", async () => {
    const longSec = makeSection(Array.from({ length: 14 }, () => paragraph(500)), "Multi");
    const chunks = await chunkChapter({
      section: longSec,
      chapterIndex: 0,
      bookTitle: "B",
      bookSourcePath: "/x",
      overlapParagraphs: 0,
      maxParagraphsForDrift: 0,
    });
    if (chunks.length < 2) throw new Error("need ≥2 chunks");

    let calls = 0;
    const memorySeen: string[] = [];
    const mockLlm = async ({ messages }: { messages: Array<{ content: string }> }) => {
      calls++;
      memorySeen.push(messages[0].content);
      const essence =
        `Concept number ${calls} about lorem ipsum patterns in distributed systems design and caching tradeoffs.`;
      return JSON.stringify(
        mockDeltaPayload({
          essence,
          proof:
            "lorem ipsum dolor sit amet consectetur adipiscing elit detailed deep explanation here for the test purposes only.",
          chapterContext: "The chapter explores lorem ipsum patterns across multiple chunks for testing memory.",
        }),
      );
    };
    const result = await extractDeltaKnowledge({
      chunks,
      chapterThesis: thesis,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.accepted.length < 2) throw new Error(`only ${result.accepted.length} accepted`);
    if (memorySeen[0].includes("Already extracted from earlier chunks")) {
      throw new Error("first call must NOT have memory block");
    }
    if (!memorySeen[1].includes("Already extracted from earlier chunks")) {
      throw new Error("second call MUST have memory block");
    }
    if (!memorySeen[1].toLowerCase().includes("concept number 1")) {
      throw new Error("memory missing first essence hint");
    }
  });

  /* === Reasoning Decoder === */

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
    const filler = "lorem ipsum [unbalanced bracket here ".repeat(1000);
    const input = filler + "[{\"final\":true}]";
    const t0 = Date.now();
    const out = extractJsonFromReasoning(input);
    const dt = Date.now() - t0;
    if (!out) throw new Error("decoder returned null");
    if (dt > 500) throw new Error(`decoder too slow: ${dt}ms (catastrophic backtracking risk)`);
    if (JSON.parse(out)[0].final !== true) throw new Error("wrong array picked");
  });

  /* === Reasoning fallback в delta-extractor === */

  await step("D2-1 — пустой content + JSON в reasoning → delta принимается", async () => {
    clearPromptCache();
    const chunkText = "Premature optimization is the root of all evil in software design decisions.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const validJson = JSON.stringify(
      mockDeltaPayload({
        essence:
          "Premature optimization is harmful because it trades unmeasured micro-gains for obscured systemic bottlenecks in large codebases.",
        proof:
          "Optimizing before profiling biases the codebase toward speculative wins while hiding bottlenecks measurement would surface; cost: brittle abstractions.",
        chapterContext: "The chapter warns against optimizing before understanding real bottlenecks in software systems.",
        tags: ["optimization", "design"],
      }),
    );
    const mockLlm = async (): Promise<{ content: string; reasoningContent?: string }> => ({
      content: "",
      reasoningContent: `Let me think about this carefully. The chunk talks about... I'll output: ${validJson}`,
    });
    const result = await extractDeltaKnowledge({
      chunks,
      chapterThesis: thesis,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.accepted.length !== 1) {
      throw new Error(`expected 1 accepted from reasoning fallback, got ${result.accepted.length}`);
    }
  });

  await step("D2-2 — невалидный content + валидный reasoning → fallback", async () => {
    clearPromptCache();
    const chunkText = "Cohesion within a module reduces coupling between modules across the codebase boundary.";
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const validJson = JSON.stringify(
      mockDeltaPayload({
        essence:
          "High cohesion within modules drives low coupling between them because a smaller public surface reduces accidental cross-module dependencies.",
        proof:
          "When responsibilities align tightly inside a module, fewer symbols leak across boundaries, so other modules form fewer incidental dependencies.",
        chapterContext: "The chapter relates cohesion and coupling in modular software architecture.",
        tags: ["modularity", "coupling"],
      }),
    );
    const mockLlm = async (): Promise<{ content: string; reasoningContent?: string }> => ({
      content: "Sure! I'll think about this. NOT JSON.",
      reasoningContent: `My final answer: ${validJson}`,
    });
    const result = await extractDeltaKnowledge({
      chunks,
      chapterThesis: thesis,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.accepted.length !== 1) {
      throw new Error(`expected 1 accepted from reasoning fallback, got ${result.accepted.length}`);
    }
  });

  await step("D2-3 — пустой content и reasoning → AURA null / 0 accepted", async () => {
    clearPromptCache();
    const chunkText = paragraph(100);
    const section = makeSection([chunkText]);
    const chunks = await chunkChapter({ section, chapterIndex: 0, bookTitle: "B", bookSourcePath: "/x" });
    const mockLlm = async (): Promise<{ content: string; reasoningContent?: string }> => ({
      content: "",
      reasoningContent: undefined,
    });
    const result = await extractDeltaKnowledge({
      chunks,
      chapterThesis: thesis,
      promptsDir: null,
      callbacks: { llm: mockLlm },
    });
    if (result.accepted.length !== 0) throw new Error("expected 0 accepted");
    if (result.perChunk[0]?.delta !== null) throw new Error("chunk should not produce delta");
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
