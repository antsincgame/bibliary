import * as path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { parseBook, isSupportedBook } from "../electron/lib/scanner/index.js";
import { chunkChapter, extractDeltaKnowledge, isNonContentSection, clearPromptCache } from "../electron/lib/dataset-v2/index.js";
import { extractChapterThesis } from "../electron/lib/dataset-v2/delta-extractor.js";
import { embedPassage } from "../electron/lib/embedder/shared.js";
import { chatWithPolicy } from "../electron/lmstudio-client.js";
import { getModelProfile } from "../electron/lib/dataset-v2/model-profile.js";
import { buildDeltaKnowledgeResponseFormat } from "../electron/lib/dataset-v2/json-schemas.js";
import { ALLOWED_DOMAINS } from "../electron/crystallizer-constants.js";
import { fetchQdrantJson } from "../electron/lib/qdrant/http-client.js";
import { EMBEDDING_DIM } from "../electron/lib/scanner/embedding.js";
import { collectProbeBooksFromRoots, getSourceRootsFromArgv } from "./e2e-source-roots.js";

const HTTP_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const argv = process.argv.slice(2);
const SOURCE_ROOTS = getSourceRootsFromArgv(argv, path.join(process.cwd(), "data", "library"));

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function argValue(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const KEEP_COLLECTION = argv.includes("--keep");
const COLLECTION = argValue("--collection") ?? `bibliary-e2e-delta-live-${Date.now()}`;
const MAX_BOOK_SIZE_BYTES = Math.max(1, Number(argValue("--max-book-mb") ?? "12")) * 1024 * 1024;

type BookFile = { ext: string; absPath: string; fileName: string; sizeBytes: number; mtimeMs: number };
type Candidate = {
  book: BookFile;
  title: string;
  chapterIndex: number;
  chapterTitle: string;
  words: number;
  paragraphs: string[];
};

async function probeServices(): Promise<void> {
  try {
    const lm = await fetch(`${HTTP_URL}/v1/models`);
    if (!lm.ok) throw new Error(`LM Studio HTTP ${lm.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`LM Studio unavailable at ${HTTP_URL}: ${message}`);
  }

  try {
    const qd = await fetch(`${QDRANT_URL}/collections`);
    if (!qd.ok) throw new Error(`Qdrant HTTP ${qd.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Qdrant unavailable at ${QDRANT_URL}: ${message}`);
  }
}

async function collectBooks(): Promise<BookFile[]> {
  const books = await collectProbeBooksFromRoots(SOURCE_ROOTS, 4);
  return books
    .filter((b) => isSupportedBook(b.absPath))
    .filter((b) => b.sizeBytes <= MAX_BOOK_SIZE_BYTES)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function sectionWordCount(paragraphs: string[]): number {
  return paragraphs.reduce((sum, p) => sum + p.split(/\s+/).filter(Boolean).length, 0);
}

async function pickCandidate(books: BookFile[]): Promise<Candidate | null> {
  for (const book of books) {
    let parsed;
    try {
      parsed = await parseBook(book.absPath);
    } catch {
      continue;
    }
    const sections = parsed.sections
      .map((section, chapterIndex) => ({
        section,
        chapterIndex,
        words: sectionWordCount(section.paragraphs),
      }))
      .filter((s) => s.section.paragraphs.length >= 4)
      .filter((s) => s.words >= 250)
      .filter((s) => !isNonContentSection(s.section))
      .sort((a, b) => b.words - a.words);
    const chosen = sections[0];
    if (!chosen) continue;
    return {
      book,
      title: parsed.metadata.title || book.fileName,
      chapterIndex: chosen.chapterIndex,
      chapterTitle: chosen.section.title,
      words: chosen.words,
      paragraphs: chosen.section.paragraphs,
    };
  }
  return null;
}

async function pickModel(): Promise<string> {
  const resp = await fetch(`${HTTP_URL}/v1/models`);
  if (!resp.ok) throw new Error(`LM Studio HTTP ${resp.status}`);
  const data = (await resp.json()) as { data: Array<{ id: string }> };
  const available = data.data.map((m) => m.id);
  const preferred = ["qwen/qwen3.6-35b-a3b", "qwen/qwen3-coder-30b", "mistral-small-3.1-24b-instruct-2503-hf", "qwen/qwen3.5-9b"];
  return preferred.find((m) => available.includes(m)) ?? available[0] ?? "";
}

async function buildLlm(model: string) {
  const profile = await getModelProfile(model);
  const allowedDomains = Array.from(ALLOWED_DOMAINS).sort();
  return async ({
    messages,
    temperature,
    maxTokens,
  }: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; reasoningContent?: string }> => {
    const response = await chatWithPolicy({
      model,
      messages,
      sampling: {
        temperature: temperature ?? 0.2,
        top_p: 0.9,
        top_k: 30,
        min_p: 0,
        presence_penalty: 0,
        max_tokens: Math.max(maxTokens ?? 4096, profile.maxTokens),
      },
      stop: profile.stop,
      responseFormat: profile.useResponseFormat ? buildDeltaKnowledgeResponseFormat(allowedDomains) : undefined,
      chatTemplateKwargs: profile.chatTemplateKwargs,
    });
    return { content: response.content, reasoningContent: response.reasoningContent };
  };
}

async function qdrantCount(collection: string): Promise<number> {
  try {
    const data = await fetchQdrantJson<{ result: { points_count?: number } }>(`${QDRANT_URL}/collections/${collection}`);
    return data.result.points_count ?? 0;
  } catch {
    return 0;
  }
}

async function ensureCollection(collection: string): Promise<void> {
  await fetchQdrantJson(`${QDRANT_URL}/collections/${collection}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
    timeoutMs: 20_000,
  }).catch(() => undefined);
}

async function runExtractionOnce(candidate: Candidate, collection: string, model: string): Promise<{ chunks: number; accepted: number; skipped: number }> {
  const llm = await buildLlm(model);
  const section = {
    level: 1,
    title: candidate.chapterTitle,
    paragraphs: candidate.paragraphs,
  };
  const chunks = await chunkChapter({
    section,
    chapterIndex: candidate.chapterIndex,
    bookTitle: candidate.title,
    bookSourcePath: candidate.book.absPath,
  });
  if (chunks.length === 0) return { chunks: 0, accepted: 0, skipped: 0 };

  const thesis = await extractChapterThesis(candidate.chapterTitle, candidate.paragraphs.join("\n\n"), { llm }, null);
  const deltas = await extractDeltaKnowledge({
    chunks,
    chapterThesis: thesis,
    promptsDir: null,
    callbacks: {
      llm,
      onEvent: (event) => {
        if (event.type === "delta.chunk.error") {
          console.log(`    ${COLOR.red}[delta error]${COLOR.reset} chunk=${event.chunkPart} ${event.error}`);
        } else if (event.type === "delta.chunk.skip") {
          console.log(`    ${COLOR.yellow}[delta skip]${COLOR.reset} chunk=${event.chunkPart} ${event.reason}`);
        }
      },
    },
  });

  for (const delta of deltas.accepted) {
    const vector = await embedPassage(delta.essence);
    await fetchQdrantJson(`${QDRANT_URL}/collections/${collection}/points?wait=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [{
          id: delta.id,
          vector,
          payload: {
            domain: delta.domain,
            chapterContext: delta.chapterContext,
            essence: delta.essence,
            cipher: delta.cipher,
            proof: delta.proof,
            applicability: delta.applicability,
            auraFlags: delta.auraFlags,
            tags: delta.tags,
            relations: delta.relations,
            bookSourcePath: delta.bookSourcePath,
            acceptedAt: delta.acceptedAt,
          },
        }],
      }),
      timeoutMs: 20_000,
    });
  }

  return {
    chunks: chunks.length,
    accepted: deltas.accepted.length,
    skipped: chunks.length - deltas.accepted.length,
  };
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}== Bibliary Delta live smoke ==${COLOR.reset}\n`);
  console.log(`LM Studio  : ${HTTP_URL}`);
  console.log(`Qdrant     : ${QDRANT_URL}`);
  console.log(`Collection : ${COLLECTION}`);
  console.log(`Roots      : ${SOURCE_ROOTS.join(" | ")}`);
  console.log("");

  clearPromptCache();
  await probeServices();
  const books = await collectBooks();
  if (books.length === 0) throw new Error("No supported books found in any source root");

  const candidate = await pickCandidate(books);
  if (!candidate) throw new Error("No content chapter found in available books");

  const model = await pickModel();
  if (!model) throw new Error("No LM Studio model available");

  console.log(`${COLOR.cyan}[candidate]${COLOR.reset} ${candidate.book.fileName}`);
  console.log(`${COLOR.cyan}[chapter]${COLOR.reset} #${candidate.chapterIndex} "${candidate.chapterTitle.slice(0, 80)}" (${candidate.words} words)`);
  console.log(`${COLOR.cyan}[model]${COLOR.reset} ${model}\n`);

  const qdrant = new QdrantClient({ url: QDRANT_URL });
  await ensureCollection(COLLECTION);

  const before = await qdrantCount(COLLECTION);
  const first = await runExtractionOnce(candidate, COLLECTION, model);
  const afterFirst = await qdrantCount(COLLECTION);

  if (first.chunks === 0) throw new Error("chunkChapter produced 0 chunks");
  if (first.accepted === 0) throw new Error("Delta extraction accepted 0 chunks");
  if (afterFirst < before + first.accepted) {
    throw new Error(`Qdrant count mismatch after first run: before=${before} after=${afterFirst} accepted=${first.accepted}`);
  }

  const second = await runExtractionOnce(candidate, COLLECTION, model);
  const afterSecond = await qdrantCount(COLLECTION);

  if (afterSecond !== afterFirst) {
    throw new Error(`Idempotency broken: afterFirst=${afterFirst}, afterSecond=${afterSecond}`);
  }

  console.log(`${COLOR.green}PASS${COLOR.reset} first run  : chunks=${first.chunks} accepted=${first.accepted} skipped=${first.skipped}`);
  console.log(`${COLOR.green}PASS${COLOR.reset} second run : chunks=${second.chunks} accepted=${second.accepted} skipped=${second.skipped} (count unchanged)`);

  if (!KEEP_COLLECTION) {
    await qdrant.deleteCollection(COLLECTION).catch(() => undefined);
    console.log(`${COLOR.dim}cleanup: deleted ${COLLECTION}${COLOR.reset}`);
  } else {
    console.log(`${COLOR.dim}cleanup: kept ${COLLECTION}${COLOR.reset}`);
  }
}

main().catch((e) => {
  console.error(`\n${COLOR.red}FAIL${COLOR.reset}`, e instanceof Error ? e.message : String(e));
  process.exit(1);
});
