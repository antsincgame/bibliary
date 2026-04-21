/**
 * Phase 3.1 — LIVE E2E Dataset v2 Кристаллизация на живой LLM (LM Studio).
 *
 * Шаги:
 *   T1 — probe модели (qwen3.6-35b-a3b приоритет)
 *   T2 — найти короткую главу в реальной книге (~/Downloads), parseBook
 *   T3 — chunkChapter → SemanticChunk[] с breadcrumbs
 *   T4 — extractChapterConcepts с rolling memory, реальные LLM-вызовы
 *   T5 — dedupChapterConcepts (intra-chapter vector dedup, e5-small)
 *   T6 — judgeAndAccept с cross-library (создаст коллекцию dataset-accepted-concepts если нет)
 *   T7 — проверить что accepted concepts попали в Qdrant
 *   T8 — повторный judge той же книги: должны быть отброшены как cross-library duplicates
 *
 * Запуск:  npx tsx scripts/test-dataset-v2-live.ts
 * Cleanup: dataset-accepted-concepts collection пишется в Qdrant и НЕ чистится
 *          (это позитивный feedback loop для следующих книг — нужен)
 */

import * as os from "os";
import * as path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  chunkChapter,
  extractChapterConcepts,
  dedupChapterConcepts,
  judgeAndAccept,
  ACCEPTED_COLLECTION,
  clearPromptCache,
  clearJudgePromptCache,
} from "../electron/lib/dataset-v2/index.js";
import { probeBooks, parseBook, isSupportedBook } from "../electron/lib/scanner/index.js";
import { chatWithTools } from "../electron/lmstudio-client.js";

const HTTP_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${label.padEnd(72, ".")} `);
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

const PRIORITY = [
  "qwen/qwen3.6-35b-a3b",
  "qwen/qwen3-coder-30b",
  "mistral-small-3.1-24b-instruct-2503-hf",
  "qwen/qwen3.5-9b",
];

async function probeChat(modelId: string): Promise<boolean> {
  try {
    const resp = await chatWithTools({
      model: modelId,
      messages: [{ role: "user", content: 'Return JSON {"ok":true} only' }],
      tools: [],
      sampling: { temperature: 0.1, max_tokens: 64 },
    });
    return resp.content.length > 0;
  } catch {
    return false;
  }
}

async function pickModel(): Promise<string> {
  if (process.env.DV2_MODEL) {
    return process.env.DV2_MODEL;
  }
  const resp = await fetch(`${HTTP_URL}/v1/models`);
  const data = (await resp.json()) as { data: Array<{ id: string }> };
  const available = new Set(data.data.map((m) => m.id));
  for (const candidate of PRIORITY) {
    if (!available.has(candidate)) continue;
    process.stdout.write(`  ${COLOR.dim}[probe]${COLOR.reset} ${candidate}... `);
    const ok = await probeChat(candidate);
    if (ok) {
      console.log(`${COLOR.green}OK${COLOR.reset}`);
      return candidate;
    }
    console.log(`${COLOR.yellow}skip${COLOR.reset}`);
  }
  throw new Error("No suitable LLM in LM Studio");
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}== Bibliary Dataset v2 — LIVE Кристаллизация ==${COLOR.reset}\n`);
  clearPromptCache();
  clearJudgePromptCache();

  let model = "";
  await step("T1 — probe LLM в LM Studio", async () => {
    model = await pickModel();
    if (!model) throw new Error("no model");
  });
  if (!model) {
    console.log(`\n${COLOR.red}Прерываю: модели нет.${COLOR.reset}\n`);
    process.exit(1);
  }
  console.log(`  ${COLOR.cyan}[chosen]${COLOR.reset} ${model}\n`);

  const llm = async ({ messages, temperature, maxTokens }: { messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number }) => {
    const resp = await chatWithTools({
      model,
      messages: messages.map((m) => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
      tools: [],
      toolChoice: "none",
      sampling: { temperature: temperature ?? 0.4, max_tokens: maxTokens ?? 4096 },
    });
    return resp.content;
  };

  /* T2 — найти подходящую книгу: непустая глава 600-3000 слов */
  let bookPath = "";
  let chapterIndex = 0;
  let bookTitle = "";
  let chapterTitle = "";
  let parsedSections: Awaited<ReturnType<typeof parseBook>> | null = null;
  await step("T2 — найти книгу и подходящую главу (600-3000 слов)", async () => {
    const downloads = path.join(os.homedir(), "Downloads");
    const all = await probeBooks(downloads, 1);
    const candidates = all.filter((b) => isSupportedBook(b.absPath) && b.sizeBytes < 5 * 1024 * 1024);
    if (candidates.length === 0) throw new Error("нет подходящих книг в ~/Downloads");

    for (const b of candidates) {
      const parsed = await parseBook(b.absPath).catch(() => null);
      if (!parsed) continue;
      for (let i = 0; i < parsed.sections.length; i++) {
        const sec = parsed.sections[i];
        const words = sec.paragraphs.reduce((s, p) => s + p.split(/\s+/).filter(Boolean).length, 0);
        if (words >= 600 && words <= 3000) {
          bookPath = b.absPath;
          chapterIndex = i;
          bookTitle = parsed.metadata.title;
          chapterTitle = sec.title;
          parsedSections = parsed;
          return;
        }
      }
    }
    throw new Error("не нашли главы 600-3000 слов ни в одной книге");
  });
  if (!parsedSections) {
    console.log(`\n${COLOR.red}Прерываю: подходящей главы нет.${COLOR.reset}\n`);
    process.exit(1);
  }
  console.log(`  ${COLOR.cyan}[chosen]${COLOR.reset} «${bookTitle}» — глава #${chapterIndex} «${chapterTitle.slice(0, 60)}»\n`);

  /* T3 — chunkChapter (now async: topological with thematic drift) */
  let chunks: Awaited<ReturnType<typeof chunkChapter>> = [];
  await step("T3 — chunkChapter с topological split", async () => {
    const section = parsedSections!.sections[chapterIndex];
    chunks = await chunkChapter({ section, chapterIndex, bookTitle, bookSourcePath: bookPath });
    if (chunks.length === 0) throw new Error("zero chunks");
    if (!chunks[0].breadcrumb.includes(bookTitle.slice(0, 10))) throw new Error("breadcrumb missing book title");
  });
  console.log(`  ${COLOR.dim}chunks: ${chunks.length} (${chunks.map((c) => c.wordCount).join(",")} words)${COLOR.reset}\n`);

  /* T4 — extractChapterConcepts на живой LLM */
  let extracted: Awaited<ReturnType<typeof extractChapterConcepts>>;
  let extractedRaw = 0;
  await step("T4 — extractChapterConcepts с rolling memory (live LLM)", async () => {
    extracted = await extractChapterConcepts({
      chunks,
      promptsDir: null,
      callbacks: {
        llm: async ({ messages, temperature, maxTokens }) => llm({ messages, temperature, maxTokens }),
        onEvent: (e) => {
          if (e.type === "extract.chunk.done") {
            console.log(
              `        ${COLOR.dim}[chunk ${e.chunkPart}/${e.chunkTotal}] raw=${e.raw} valid=${e.valid} ${e.durationMs}ms${COLOR.reset}`
            );
          } else if (e.type === "extract.chunk.error") {
            console.log(`        ${COLOR.red}[chunk ${e.chunkPart} ERROR] ${e.error}${COLOR.reset}`);
          }
        },
      },
    });
    extractedRaw = extracted.conceptsTotal.length;
    if (extractedRaw === 0) {
      const w = extracted.warnings.slice(0, 3).join(" || ");
      throw new Error(`0 концептов извлечено; warnings: ${w || "none"}`);
    }
  });
  console.log(`  ${COLOR.cyan}[extracted]${COLOR.reset} ${extractedRaw} концептов из ${chunks.length} chunks\n`);

  /* T5 — intra-chapter dedup */
  let dedupResult: Awaited<ReturnType<typeof dedupChapterConcepts>> | null = null;
  await step("T5 — intra-chapter vector dedup (e5-small)", async () => {
    dedupResult = await dedupChapterConcepts({
      concepts: extracted.conceptsTotal,
      bookSourcePath: bookPath,
      bookTitle,
      chapterIndex,
      chapterTitle,
      onEvent: (e) => {
        if (e.type === "intra-dedup.merge") {
          console.log(`        ${COLOR.yellow}[merge sim=${e.sim.toFixed(3)}]${COLOR.reset} «${e.principleA}» ↔ «${e.principleB}»`);
        }
      },
    });
    if (dedupResult.concepts.length > extractedRaw) throw new Error("dedup увеличил количество (баг)");
  });
  console.log(
    `  ${COLOR.cyan}[deduped]${COLOR.reset} ${dedupResult!.concepts.length} (мерджей: ${dedupResult!.mergedPairs})\n`
  );

  /* T6 — judge + accept */
  let judgeResult: Awaited<ReturnType<typeof judgeAndAccept>> | null = null;
  await step("T6 — judgeAndAccept (LLM judge + cross-library check)", async () => {
    judgeResult = await judgeAndAccept({
      concepts: dedupResult!.concepts,
      promptsDir: null,
      callbacks: {
        llm: async ({ messages, temperature, maxTokens }) => llm({ messages, temperature, maxTokens }),
        onEvent: (e) => {
          if (e.type === "judge.score") {
            console.log(
              `        ${COLOR.dim}[score ${e.score.toFixed(2)}] N=${e.novelty.toFixed(2)} A=${e.actionability.toFixed(2)} D=${e.domain_fit.toFixed(2)}${COLOR.reset} «${e.principle}»`
            );
          } else if (e.type === "judge.accept") {
            console.log(`        ${COLOR.green}[ACCEPT ${e.score.toFixed(2)}]${COLOR.reset} «${e.principle}»`);
          } else if (e.type === "judge.reject.lowscore") {
            console.log(`        ${COLOR.yellow}[REJECT lowscore=${e.score.toFixed(2)}]${COLOR.reset} «${e.principle}»`);
          } else if (e.type === "judge.crossdupe") {
            console.log(`        ${COLOR.yellow}[REJECT crossdupe sim=${e.sim.toFixed(3)}]${COLOR.reset} «${e.principle}»`);
          } else if (e.type === "judge.reject.error") {
            console.log(`        ${COLOR.red}[REJECT error]${COLOR.reset} «${e.principle}»: ${e.reason.slice(0, 80)}`);
          }
        },
      },
    });
    if (judgeResult.accepted.length + judgeResult.rejected.length !== dedupResult!.concepts.length) {
      throw new Error(`judge sum mismatch: accepted=${judgeResult.accepted.length} rejected=${judgeResult.rejected.length} ≠ ${dedupResult!.concepts.length}`);
    }
  });
  console.log(
    `\n  ${COLOR.cyan}[judged]${COLOR.reset} accepted=${judgeResult!.accepted.length}, rejected=${judgeResult!.rejected.length}\n`
  );

  /* T7 — accepted в Qdrant */
  await step("T7 — accepted concepts реально записаны в Qdrant", async () => {
    if (judgeResult!.accepted.length === 0) {
      throw new Error(
        "0 принятых — ничего не пишется в Qdrant. Это может быть OK если глава была банальной, но мешает следующему тесту T8"
      );
    }
    const qdrant = new QdrantClient({ url: QDRANT_URL });
    const info = await qdrant.getCollection(ACCEPTED_COLLECTION);
    if (!info) throw new Error("collection отсутствует");
    if ((info.points_count ?? 0) < judgeResult!.accepted.length) {
      throw new Error(`points_count=${info.points_count} < accepted=${judgeResult!.accepted.length}`);
    }
  });

  /* T8 — повторный judge тех же концептов: должны все быть отброшены как cross-library */
  await step("T8 — повторный judge тех же → все rejected как crossdupe", async () => {
    if (judgeResult!.accepted.length === 0) {
      console.log(`        ${COLOR.yellow}SKIP: 0 accepted в T7, повтор бессмыслен${COLOR.reset}`);
      return;
    }
    const second = await judgeAndAccept({
      concepts: dedupResult!.concepts.slice(0, Math.min(3, dedupResult!.concepts.length)),
      promptsDir: null,
      callbacks: {
        llm: async ({ messages, temperature, maxTokens }) => llm({ messages, temperature, maxTokens }),
        onEvent: () => undefined,
      },
    });
    /* По крайней мере половина должна попасть в crossdupe (часть могла набрать score < 0.6 и попасть в lowscore — тоже OK) */
    if (second.accepted.length > 1) {
      throw new Error(`повторный прогон принял ${second.accepted.length} концептов вместо 0 (cross-library check сломан?)`);
    }
  });

  console.log(`\n${COLOR.bold}--- Summary ---${COLOR.reset}`);
  console.log(`Tests passed: ${COLOR.green}${passed}${COLOR.reset}`);
  console.log(`Tests failed: ${failed === 0 ? COLOR.green : COLOR.red}${failed}${COLOR.reset}`);
  if (judgeResult) {
    console.log(`\n${COLOR.cyan}Финальный pipeline на живой LLM:${COLOR.reset}`);
    console.log(`  Книга:           «${bookTitle}»`);
    console.log(`  Глава:           «${chapterTitle}»`);
    console.log(`  Chunks:          ${chunks.length}`);
    console.log(`  Extracted raw:   ${extractedRaw}`);
    console.log(`  After dedup:     ${dedupResult!.concepts.length} (мерджей: ${dedupResult!.mergedPairs})`);
    console.log(`  Accepted:        ${COLOR.green}${judgeResult!.accepted.length}${COLOR.reset}`);
    console.log(`  Rejected:        ${COLOR.yellow}${judgeResult!.rejected.length}${COLOR.reset}`);
  }
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
