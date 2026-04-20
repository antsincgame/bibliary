import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import "dotenv/config";

const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_DELAY_MS = 300;
const MAX_RETRIES = 2;
const LLM_TEMPERATURE = 0.7;
const LLM_MAX_TOKENS = 4096;

const FINETUNE_DIR = "data/finetune";
const SOURCE_PATH = `${FINETUNE_DIR}/source-chunks.json`;
const PROGRESS_PATH = `${FINETUNE_DIR}/progress.json`;
const GOLD_PATH = `${FINETUNE_DIR}/gold-examples.jsonl`;
const BATCHES_DIR = `${FINETUNE_DIR}/batches`;

interface SourceChunk {
  id: string;
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
}

interface Progress {
  total_chunks: number;
  processed_count: number;
  remaining_count: number;
  processed_chunk_ids: string[];
  batches: Array<{
    name: string;
    file: string;
    chunk_ids: string[];
    example_count: number;
    examples_per_chunk: number;
    created_at: string;
    notes: string;
  }>;
  next_batch_index: number;
  examples_per_chunk_target: number;
  batch_size_target: number;
}

interface GoldExample {
  conversations: Array<{ from: string; value: string }>;
  meta: { type: string; domain: string; source_chunk_id: string; principle_head: string };
}

interface LmStudioResponse {
  choices: Array<{ message: { content: string } }>;
}

const MECHANICUS_SYSTEM_PROMPT = `You are a MECHANICUS knowledge encoder. You convert editorial wisdom from books about UX, copywriting, SEO, UI, and mobile design into compressed MECHANICUS-format chunks for a vector database.

SCHEMA (strict JSON, single object):
- principle: action-oriented transformation rule, 3-300 chars. NEVER a definition.
- explanation: MECHANICUS code, 10-500 chars. Format: X.<domain>|rule_label: instruction; NO:antipattern; eg: "before" >> "after"
- domain: one of "copy" | "seo" | "ux" | "ui" | "mobile" | "perf" | "research"
- tags: array of 1-10 kebab-case strings, specific to subtopic

OPERATORS:
-> sequence / leads to
== equivalence
!= not equal
+ combine
- removes
>> transformation (LEFT=bad, RIGHT=good)
NO: antipattern
eg: concrete example with before >> after

QUALITY RULE: The principle must let a practitioner TRANSFORM their work immediately. Definitions fail the /om test. Transformations pass.

OUTPUT: a single valid JSON object. No prose, no markdown fences, no commentary.`;

function buildT1Prompt(chunk: SourceChunk, fewShotExamples: string): string {
  return `You are a dataset engineer creating training data for a MECHANICUS knowledge encoder model.

Given a MECHANICUS chunk (the model's expected output), generate a **T1 input** — a simulated book excerpt (150-220 words) that a human would provide, and which the model should encode into the given chunk.

REQUIREMENTS for T1 (source passage):
- Must read like a real book excerpt (varied author voices, not always "From book X:")
- Self-contained — a practitioner could encode it without outside context
- Contains enough detail to justify every element of the output chunk
- Mix English and Russian across the dataset

${fewShotExamples}

TARGET CHUNK:
${JSON.stringify(chunk, null, 2)}

Generate ONLY the T1 text (the source passage). No JSON wrapping, no commentary, no labels. Just the passage text.`;
}

function buildT2Prompt(chunk: SourceChunk, fewShotExamples: string): string {
  return `You are a dataset engineer creating training data for a MECHANICUS knowledge encoder model.

Given a MECHANICUS chunk (the model's expected output), generate a **T2 input** — a practical user question that this chunk answers.

REQUIREMENTS for T2 (user question):
- State a real practitioner problem, not a definition request
- Match the level of specificity of the answer
- Mix Russian and English roughly 50/50 across the dataset
- One concrete question, 1-3 sentences

${fewShotExamples}

TARGET CHUNK:
${JSON.stringify(chunk, null, 2)}

Generate ONLY the T2 text (the question). No JSON wrapping, no commentary, no labels. Just the question.`;
}

function buildT3Prompt(chunk: SourceChunk, fewShotExamples: string): string {
  return `You are a dataset engineer creating training data for a MECHANICUS knowledge encoder model.

Given a MECHANICUS chunk (the model's expected output), generate a **T3 input** — a brief 1-2 line idea/hint that the model should expand into the full MECHANICUS chunk.

REQUIREMENTS for T3 (brief idea):
- Compress the core idea in 1-2 lines
- Leave room for the model to add operators, antipatterns, and the eg: before >> after
- Can be in Russian or English

${fewShotExamples}

TARGET CHUNK:
${JSON.stringify(chunk, null, 2)}

Generate ONLY the T3 text (the brief idea). No JSON wrapping, no commentary, no labels. Just the hint.`;
}

function loadGoldExamples(): GoldExample[] {
  const raw = readFileSync(GOLD_PATH, "utf8").trim();
  return raw.split("\n").map((line) => JSON.parse(line) as GoldExample);
}

function buildFewShotBlock(goldExamples: GoldExample[], domain: string, type: "T1" | "T2" | "T3"): string {
  const matching = goldExamples.filter((ex) => ex.meta.type === type && ex.meta.domain === domain);
  const fallback = goldExamples.filter((ex) => ex.meta.type === type);
  const examples = matching.length >= 2 ? matching.slice(0, 2) : fallback.slice(0, 2);

  if (examples.length === 0) return "";

  const blocks = examples.map((ex, i) => {
    const humanValue = ex.conversations.find((c) => c.from === "human")?.value ?? "";
    const gptValue = ex.conversations.find((c) => c.from === "gpt")?.value ?? "";
    return `EXAMPLE ${i + 1}:
Input (${type}): ${humanValue.slice(0, 300)}${humanValue.length > 300 ? "..." : ""}
Output chunk: ${gptValue.slice(0, 200)}...`;
  });

  return `FEW-SHOT EXAMPLES:\n${blocks.join("\n\n")}`;
}

async function callLmStudio(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local-model",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: LLM_TEMPERATURE,
      max_tokens: LLM_MAX_TOKENS,
    }),
  });

  if (!response.ok) {
    throw new Error(`LM Studio HTTP ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as LmStudioResponse;
  const content = data.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LM Studio returned empty response");
  }
  return content.trim();
}

async function generateWithRetry(
  systemPrompt: string,
  userPrompt: string,
  label: string
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLmStudio(systemPrompt, userPrompt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_RETRIES) {
        console.warn(`  [retry ${attempt + 1}/${MAX_RETRIES}] ${label}: ${msg}`);
        await sleep(1000 * (attempt + 1));
      } else {
        throw new Error(`${label} failed after ${MAX_RETRIES + 1} attempts: ${msg}`);
      }
    }
  }
  throw new Error("unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildShareGptLine(
  type: string,
  humanInput: string,
  chunk: SourceChunk
): string {
  const chunkJson = JSON.stringify({
    principle: chunk.principle,
    explanation: chunk.explanation,
    domain: chunk.domain,
    tags: chunk.tags,
  });

  const example = {
    conversations: [
      { from: "system", value: MECHANICUS_SYSTEM_PROMPT },
      { from: "human", value: humanInput },
      { from: "gpt", value: chunkJson },
    ],
    meta: {
      type,
      domain: chunk.domain,
      source_chunk_id: chunk.id,
      principle_head: chunk.principle.slice(0, 60),
    },
  };

  return JSON.stringify(example);
}

function parseArgs(): { batchSize: number; delayMs: number } {
  let batchSize = DEFAULT_BATCH_SIZE;
  let delayMs = DEFAULT_DELAY_MS;

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--batch-size" && process.argv[i + 1]) {
      batchSize = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === "--delay-ms" && process.argv[i + 1]) {
      delayMs = parseInt(process.argv[i + 1], 10);
      i++;
    }
  }

  return { batchSize, delayMs };
}

async function main(): Promise<void> {
  const { batchSize, delayMs } = parseArgs();

  if (!existsSync(SOURCE_PATH)) {
    console.error(`Source file not found: ${SOURCE_PATH}`);
    process.exit(1);
  }

  const allChunks = JSON.parse(readFileSync(SOURCE_PATH, "utf8")) as SourceChunk[];
  const progress = JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as Progress;
  const goldExamples = loadGoldExamples();

  const processedSet = new Set(progress.processed_chunk_ids);
  const unprocessed = allChunks.filter((c) => !processedSet.has(c.id));

  if (unprocessed.length === 0) {
    console.log("All chunks have been processed. Nothing to do.");
    return;
  }

  const batch = unprocessed.slice(0, batchSize);
  const batchIndex = progress.next_batch_index;
  const batchName = `batch-${String(batchIndex).padStart(3, "0")}`;
  const batchFile = `${batchName}.jsonl`;
  const batchPath = `${BATCHES_DIR}/${batchFile}`;

  if (!existsSync(BATCHES_DIR)) {
    mkdirSync(BATCHES_DIR, { recursive: true });
  }

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  MECHANICUS Dataset Generator             ║`);
  console.log(`║  Batch: ${batchName.padEnd(32)}║`);
  console.log(`║  Chunks: ${batch.length} / ${unprocessed.length} remaining${" ".repeat(14 - String(batch.length).length - String(unprocessed.length).length)}║`);
  console.log(`║  LM Studio: ${LM_STUDIO_URL.padEnd(28)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  const lines: string[] = [];
  const processedIds: string[] = [];
  let failCount = 0;

  const onShutdown = (): void => {
    if (lines.length > 0) {
      console.log(`\nInterrupted. Saving ${lines.length} examples...`);
      saveBatch(lines, processedIds, progress, batchIndex, batchName, batchFile, batchPath);
    }
    process.exit(0);
  };

  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);

  for (let i = 0; i < batch.length; i++) {
    const chunk = batch[i];
    const prefix = `[${i + 1}/${batch.length}]`;
    console.log(`${prefix} ${chunk.domain}: ${chunk.principle.slice(0, 60)}...`);

    try {
      const fewShotT1 = buildFewShotBlock(goldExamples, chunk.domain, "T1");
      const fewShotT2 = buildFewShotBlock(goldExamples, chunk.domain, "T2");
      const fewShotT3 = buildFewShotBlock(goldExamples, chunk.domain, "T3");

      const genSystem = "You are a dataset engineer. Follow instructions precisely.";

      const t1 = await generateWithRetry(
        genSystem,
        buildT1Prompt(chunk, fewShotT1),
        `${prefix} T1`
      );
      console.log(`  T1: ${t1.slice(0, 80).replace(/\n/g, " ")}...`);

      if (delayMs > 0) await sleep(delayMs);

      const t2 = await generateWithRetry(
        genSystem,
        buildT2Prompt(chunk, fewShotT2),
        `${prefix} T2`
      );
      console.log(`  T2: ${t2.slice(0, 80).replace(/\n/g, " ")}...`);

      if (delayMs > 0) await sleep(delayMs);

      const t3 = await generateWithRetry(
        genSystem,
        buildT3Prompt(chunk, fewShotT3),
        `${prefix} T3`
      );
      console.log(`  T3: ${t3.slice(0, 80).replace(/\n/g, " ")}...`);

      lines.push(buildShareGptLine("T1", t1, chunk));
      lines.push(buildShareGptLine("T2", t2, chunk));
      lines.push(buildShareGptLine("T3", t3, chunk));
      processedIds.push(chunk.id);

      console.log(`  OK (3 examples)\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  FAILED: ${msg}\n`);
      failCount++;
    }

    if (delayMs > 0 && i < batch.length - 1) await sleep(delayMs);
  }

  if (lines.length === 0) {
    console.error("No examples generated. Check LM Studio connection.");
    process.exit(1);
  }

  saveBatch(lines, processedIds, progress, batchIndex, batchName, batchFile, batchPath);

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Generated: ${lines.length} examples from ${processedIds.length} chunks`);
  console.log(`Failed: ${failCount} chunks`);
  console.log(`Output: ${batchPath}`);
  console.log(`Remaining: ${unprocessed.length - processedIds.length} chunks`);
  console.log(`${"─".repeat(50)}`);
}

function saveBatch(
  lines: string[],
  processedIds: string[],
  progress: Progress,
  batchIndex: number,
  batchName: string,
  batchFile: string,
  batchPath: string
): void {
  writeFileSync(batchPath, lines.join("\n") + "\n", "utf8");

  progress.processed_chunk_ids.push(...processedIds);
  progress.processed_count = progress.processed_chunk_ids.length;
  progress.remaining_count = progress.total_chunks - progress.processed_count;
  progress.batches.push({
    name: batchName,
    file: batchFile,
    chunk_ids: processedIds,
    example_count: lines.length,
    examples_per_chunk: 3,
    created_at: new Date().toISOString().slice(0, 10),
    notes: `Auto-generated via LM Studio (generate-batch.ts)`,
  });
  progress.next_batch_index = batchIndex + 1;

  writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
  console.log(`Saved ${batchPath} and updated ${PROGRESS_PATH}`);
}

main().catch((e: unknown) => {
  console.error("Fatal:", e);
  process.exit(1);
});
