/**
 * E2E batch-прогон ВСЕЙ библиотеки книг через полный пайплайн Bibliary.
 *
 * Цель: диагностика — увидеть ошибки на каждом этапе (parse → chunk → extract →
 * dedup → judge → upsert) на реальных пользовательских книгах ДО реализации
 * UI тематических датасетов. Не product-функционал — инструмент для batch-аудита.
 *
 * Аналог existing scripts/e2e-*.ts, но:
 *   - probe ВСЕЙ папки (не 1-3 sample)
 *   - resume через state.json (можно прервать Ctrl+C и продолжить)
 *   - артефакты в release/e2e-report/<ts>/{index.md, chunks/, concepts/, ...}
 *
 * Запуск:
 *   npx tsx scripts/e2e-batch-library.ts \
 *     --downloads "C:\Users\Пользователь\Downloads" \
 *     --max-size-mb 50
 *
 * Optional:
 *   --restart           Игнорировать state.json (начать с нуля)
 *   --max-books N       Hard cap на число книг (для smoke)
 *   --max-chapters N    Hard cap на число глав на книгу
 *   --score-threshold X Judge threshold (default 0.6)
 *
 * Exit codes:
 *   0  завершён без фаталов (могут быть per-book errors — см. errors.md)
 *   1  пользователь прервал (Ctrl+C) — state сохранён, можно продолжить
 *   2  fatal pre-flight (LM Studio/Qdrant offline, нет Downloads, нет моделей)
 */

import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import {
  probeBooks,
  parseBook,
  type BookFileSummary,
} from "../electron/lib/scanner/parsers/index.js";
import { isOcrSupported } from "../electron/lib/scanner/ocr/index.js";
import { convertBookToMarkdown, replaceFrontmatter } from "../electron/lib/library/md-converter.js";
import type { BookCatalogMeta } from "../electron/lib/library/types.js";
import {
  chunkChapter,
  extractChapterConcepts,
  dedupChapterConcepts,
  judgeAndAccept,
  type SemanticChunk,
  type ExtractEvent,
  type IntraDedupEvent,
  type JudgeEvent,
  type AcceptedConcept,
} from "../electron/lib/dataset-v2/index.js";
import { chat } from "../electron/lmstudio-client.js";
import { getModelProfile, type ModelTag } from "../electron/lib/dataset-v2/model-profile.js";
import {
  buildExtractorResponseFormat,
  buildJudgeResponseFormat,
} from "../electron/lib/dataset-v2/json-schemas.js";
import { ALLOWED_DOMAINS } from "../electron/crystallizer-constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration & CLI
// ─────────────────────────────────────────────────────────────────────────────

const HTTP_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const QDRANT_URL_ENV = process.env.QDRANT_URL || "http://localhost:6333";

interface CliArgs {
  downloadsDir: string;
  maxSizeMb: number;
  restart: boolean;
  maxBooks: number | null;
  maxChapters: number | null;
  scoreThreshold: number;
  promptKey: "mechanicus" | "cognitive" | "auto";
  /** Корень файлового хранилища книг. По умолчанию `data/library`. */
  libraryRoot: string;
  /** Если true -- НЕ копировать оригиналы и не писать book.md (сухой прогон). */
  skipLibrary: boolean;
  /** Regex по filename: обрабатывать только книги, у которых имя матчится. */
  includePattern: RegExp | null;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const num = (flag: string, dflt: number | null): number | null => {
    const v = get(flag);
    if (v === null) return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const downloads = get("--downloads") ?? path.join(os.homedir(), "Downloads");
  const maxSizeMb = num("--max-size-mb", 50)!;
  const promptKeyRaw = get("--prompt") ?? "auto";
  const promptKey = promptKeyRaw === "mechanicus" || promptKeyRaw === "cognitive" ? promptKeyRaw : "auto";
  const libraryRoot = get("--library-root") ?? path.resolve(process.cwd(), "data", "library");
  const includeRaw = get("--include-pattern");
  const includePattern = includeRaw ? new RegExp(includeRaw, "i") : null;
  return {
    downloadsDir: downloads,
    maxSizeMb,
    restart: argv.includes("--restart"),
    maxBooks: num("--max-books", null),
    maxChapters: num("--max-chapters", null),
    scoreThreshold: num("--score-threshold", 0.6) ?? 0.6,
    promptKey,
    libraryRoot,
    skipLibrary: argv.includes("--skip-library"),
    includePattern,
  };
}

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function fatal(msg: string): never {
  console.error(`\n${COLOR.red}${COLOR.bold}FATAL:${COLOR.reset} ${msg}\n`);
  process.exit(2);
}

function info(msg: string): void {
  console.log(`${COLOR.dim}${msg}${COLOR.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight probes
// ─────────────────────────────────────────────────────────────────────────────

async function probeLmStudio(): Promise<{ models: string[] }> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const resp = await fetch(`${HTTP_URL}/v1/models`, { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) fatal(`LM Studio HTTP ${resp.status} at ${HTTP_URL}`);
    const json = (await resp.json()) as { data?: Array<{ id: string }> };
    const models = (json.data ?? []).map((m) => m.id);
    if (models.length === 0) fatal(`LM Studio is up but no models loaded. Load a model in LM Studio first.`);
    return { models };
  } catch (e) {
    fatal(`LM Studio unreachable at ${HTTP_URL}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function probeQdrant(): Promise<void> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const resp = await fetch(`${QDRANT_URL_ENV}/collections`, { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) fatal(`Qdrant HTTP ${resp.status} at ${QDRANT_URL_ENV}`);
  } catch (e) {
    fatal(`Qdrant unreachable at ${QDRANT_URL_ENV}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function probeDownloads(downloadsDir: string): Promise<void> {
  try {
    const st = await fs.stat(downloadsDir);
    if (!st.isDirectory()) fatal(`Downloads path is not a directory: ${downloadsDir}`);
  } catch (e) {
    fatal(`Downloads path not accessible: ${downloadsDir} (${e instanceof Error ? e.message : e})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model picker — copy of e2e-full-mvp.ts logic (curated tags first, hint fallback)
// ─────────────────────────────────────────────────────────────────────────────

function pickModelByHints(loaded: string[], preferences: string[]): string | null {
  for (const pref of preferences) {
    const hit = loaded.find((m) => m.toLowerCase().includes(pref));
    if (hit) return hit;
  }
  return loaded[0] ?? null;
}

async function pickModelByTags(loaded: string[], tagPriority: ModelTag[], legacyHints: string[]): Promise<string | null> {
  const enriched: Array<{ id: string; tags: ModelTag[] }> = [];
  for (const id of loaded) {
    const profile = await getModelProfile(id);
    enriched.push({ id, tags: profile.tags });
  }
  for (const tag of tagPriority) {
    const hit = enriched.find((m) => m.tags.includes(tag));
    if (hit) return hit.id;
  }
  return pickModelByHints(loaded, legacyHints);
}

// ─────────────────────────────────────────────────────────────────────────────
// Output paths & helpers
// ─────────────────────────────────────────────────────────────────────────────

function timestampDir(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s._-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  if (base.length > 0 && base !== "-") return base;
  const { createHash } = require("crypto") as typeof import("crypto");
  return "book-" + createHash("sha256").update(s).digest("hex").slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────────────
// State (resume support)
// ─────────────────────────────────────────────────────────────────────────────

type BookStatus = "pending" | "running" | "done" | "failed" | "skipped";

interface BookState {
  bookPath: string;
  bookName: string;
  status: BookStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  totalChapters?: number;
  processedChapters?: number;
  rawConcepts?: number;
  dedupedConcepts?: number;
  acceptedConcepts?: number;
  rejectedConcepts?: number;
  errors?: ErrorEntry[];
}

interface RunState {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  args: CliArgs;
  extractModel: string;
  judgeModel: string;
  totalBooksFound: number;
  books: Record<string, BookState>;
}

interface ErrorEntry {
  category:
    | "parser-failed"
    | "chunker-failed"
    | "extractor-llm-error"
    | "extractor-zero-concepts"
    | "judge-llm-error"
    | "qdrant-upsert-failed"
    | "oom"
    | "timeout"
    | "aborted"
    | "unknown";
  bookName: string;
  chapterIndex?: number;
  chapterTitle?: string;
  message: string;
}

async function loadState(stateFile: string): Promise<RunState | null> {
  try {
    const txt = await fs.readFile(stateFile, "utf8");
    return JSON.parse(txt) as RunState;
  } catch {
    return null;
  }
}

async function saveState(stateFile: string, state: RunState): Promise<void> {
  const tmp = `${stateFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, stateFile);
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM wrapper (uses model profile, identical to dataset-v2.ipc.ts makeLlm)
// ─────────────────────────────────────────────────────────────────────────────

async function buildLlm(modelKey: string, role: "extractor" | "judge", signal: AbortSignal) {
  const profile = await getModelProfile(modelKey);
  const allowed = Array.from(ALLOWED_DOMAINS).sort();
  const responseFormat = profile.useResponseFormat
    ? role === "extractor"
      ? buildExtractorResponseFormat(allowed)
      : buildJudgeResponseFormat()
    : undefined;
  return async ({
    messages,
    maxTokens,
    temperature,
  }: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; reasoningContent?: string }> => {
    const r = await chat({
      model: modelKey,
      messages,
      sampling: {
        temperature: temperature ?? (role === "extractor" ? 0.4 : 0.2),
        top_p: 0.9,
        top_k: 20,
        min_p: 0,
        presence_penalty: 0,
        max_tokens: Math.max(maxTokens ?? 4096, profile.maxTokens),
      },
      stop: profile.stop,
      responseFormat,
      chatTemplateKwargs: profile.chatTemplateKwargs,
      signal,
    });
    return { content: r.content, reasoningContent: r.reasoningContent };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-book pipeline
// ─────────────────────────────────────────────────────────────────────────────

interface BookResult {
  bookState: BookState;
  /** First N chunks of the book (sample for chunks/<slug>.json). */
  chunkSample: SemanticChunk[];
  /** All accepted concepts from the book (for concepts/<slug>.json). */
  accepted: AcceptedConcept[];
  /** Raw stage events (for raw-events.jsonl). */
  events: Array<{ stage: string; ts: string; event: unknown }>;
}

const SAMPLE_CHUNKS_PER_BOOK = 5;

function classifyError(msg: string): ErrorEntry["category"] {
  const m = msg.toLowerCase();
  if (m.includes("aborted") || m.includes("abort")) return "aborted";
  if (m.includes("oom") || m.includes("out of memory") || m.includes("heap")) return "oom";
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  if (m.includes("upsert") || m.includes("qdrant")) return "qdrant-upsert-failed";
  return "unknown";
}

async function processBook(
  book: BookFileSummary,
  args: CliArgs,
  extractModel: string,
  judgeModel: string,
  abortSignal: AbortSignal,
  promptsDir: string | null,
): Promise<BookResult> {
  const result: BookResult = {
    bookState: {
      bookPath: book.absPath,
      bookName: book.fileName,
      status: "running",
      startedAt: new Date().toISOString(),
      processedChapters: 0,
      rawConcepts: 0,
      dedupedConcepts: 0,
      acceptedConcepts: 0,
      rejectedConcepts: 0,
      errors: [],
    },
    chunkSample: [],
    accepted: [],
    events: [],
  };
  const t0 = Date.now();
  const pushErr = (category: ErrorEntry["category"], message: string, chapterIndex?: number, chapterTitle?: string): void => {
    result.bookState.errors!.push({ category, bookName: book.fileName, chapterIndex, chapterTitle, message });
  };
  const pushEv = (stage: string, ev: unknown): void => {
    result.events.push({ stage, ts: new Date().toISOString(), event: ev });
  };

  // ── Stage 1: parseBook ────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = await parseBook(book.absPath, { ocrEnabled: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushErr("parser-failed", msg);
    result.bookState.status = "failed";
    result.bookState.finishedAt = new Date().toISOString();
    result.bookState.durationMs = Date.now() - t0;
    return result;
  }

  let sections = parsed.sections;

  if (sections.length === 0 && isOcrSupported()) {
    try {
      const ocrParsed = await parseBook(book.absPath, { ocrEnabled: true, ocrAccuracy: "accurate", ocrPdfDpi: 200 });
      sections = ocrParsed.sections;
      if (sections.length > 0) {
        process.stdout.write(`    OCR fallback: recovered ${sections.length} sections\n`);
      }
    } catch (ocrErr) {
      pushErr("parser-failed", `OCR fallback failed: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`);
    }
  }

  result.bookState.totalChapters = sections.length;
  if (sections.length === 0) {
    pushErr("parser-failed", "parser returned 0 sections (OCR also failed or unavailable)");
    result.bookState.status = "failed";
    result.bookState.finishedAt = new Date().toISOString();
    result.bookState.durationMs = Date.now() - t0;
    return result;
  }

  const bookTitle = parsed.metadata.title?.trim() || path.parse(book.fileName).name;
  const chaptersToProcess = args.maxChapters ? sections.slice(0, args.maxChapters) : sections;
  const totalRawConcepts: number[] = [];

  // ── Per-chapter loop ──────────────────────────────────────────────────────
  for (let chIdx = 0; chIdx < chaptersToProcess.length; chIdx++) {
    if (abortSignal.aborted) {
      pushErr("aborted", "interrupted by user");
      break;
    }
    const section = chaptersToProcess[chIdx];
    const chapterTitle = section.title || `Chapter ${chIdx + 1}`;

    // ── Stage 2: chunkChapter ───────────────────────────────────────────────
    let chunks: SemanticChunk[];
    try {
      chunks = await chunkChapter({
        section,
        chapterIndex: chIdx,
        bookTitle,
        bookSourcePath: book.absPath,
        signal: abortSignal,
      });
    } catch (e) {
      pushErr("chunker-failed", e instanceof Error ? e.message : String(e), chIdx, chapterTitle);
      continue;
    }
    if (chunks.length === 0) {
      pushErr("chunker-failed", "0 chunks produced", chIdx, chapterTitle);
      continue;
    }
    if (result.chunkSample.length < SAMPLE_CHUNKS_PER_BOOK) {
      const need = SAMPLE_CHUNKS_PER_BOOK - result.chunkSample.length;
      result.chunkSample.push(...chunks.slice(0, need));
    }

    // ── Stage 3: extractChapterConcepts ─────────────────────────────────────
    const llmExtract = await buildLlm(extractModel, "extractor", abortSignal);
    const resolvedPromptKey: "mechanicus" | "cognitive" | undefined =
      args.promptKey === "auto"
        ? ((await getModelProfile(extractModel)).source === "thinking-heavy" ? "cognitive" : "mechanicus")
        : args.promptKey;
    let extracted;
    try {
      extracted = await extractChapterConcepts({
        chunks,
        promptsDir,
        promptKey: resolvedPromptKey,
        callbacks: {
          llm: llmExtract,
          onEvent: (ev: ExtractEvent) => {
            pushEv("extract", ev);
            if (ev.type === "extract.chunk.error") {
              pushErr("extractor-llm-error", `chunk ${ev.chunkPart}/${ev.chunkTotal}: ${ev.error}`, chIdx, chapterTitle);
            }
          },
        },
        signal: abortSignal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushErr(classifyError(msg) === "unknown" ? "extractor-llm-error" : classifyError(msg), msg, chIdx, chapterTitle);
      continue;
    }
    const rawCount = extracted.conceptsTotal.length;
    totalRawConcepts.push(rawCount);
    result.bookState.rawConcepts! += rawCount;
    if (rawCount === 0) {
      pushErr("extractor-zero-concepts", `0 valid concepts from ${chunks.length} chunks; warnings: ${extracted.warnings.slice(0, 3).join(" | ")}`, chIdx, chapterTitle);
      result.bookState.processedChapters!++;
      continue;
    }

    // ── Stage 4: dedupChapterConcepts ───────────────────────────────────────
    let deduped;
    try {
      deduped = await dedupChapterConcepts({
        concepts: extracted.conceptsTotal,
        bookSourcePath: book.absPath,
        bookTitle,
        chapterIndex: chIdx,
        chapterTitle,
        onEvent: (ev: IntraDedupEvent) => pushEv("dedup", ev),
      });
    } catch (e) {
      pushErr("unknown", `dedup: ${e instanceof Error ? e.message : String(e)}`, chIdx, chapterTitle);
      continue;
    }
    result.bookState.dedupedConcepts! += deduped.concepts.length;

    // ── Stage 5: judgeAndAccept ─────────────────────────────────────────────
    const llmJudge = await buildLlm(judgeModel, "judge", abortSignal);
    let judged;
    try {
      judged = await judgeAndAccept({
        concepts: deduped.concepts,
        promptsDir,
        scoreThreshold: args.scoreThreshold,
        callbacks: {
          llm: llmJudge,
          onEvent: (ev: JudgeEvent) => {
            pushEv("judge", ev);
            if (ev.type === "judge.reject.error") {
              pushErr("judge-llm-error", `principle "${ev.principle}": ${ev.reason}`, chIdx, chapterTitle);
            }
          },
        },
        signal: abortSignal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushErr(classifyError(msg) === "unknown" ? "judge-llm-error" : classifyError(msg), msg, chIdx, chapterTitle);
      continue;
    }
    result.accepted.push(...judged.accepted);
    result.bookState.acceptedConcepts! += judged.accepted.length;
    result.bookState.rejectedConcepts! += judged.rejected.length;
    result.bookState.processedChapters!++;

    // Прогресс per-chapter
    process.stdout.write(
      `    ${COLOR.dim}ch ${chIdx + 1}/${chaptersToProcess.length}: ${rawCount} raw → ${deduped.concepts.length} dedup → ${judged.accepted.length} accepted${COLOR.reset}\n`,
    );
  }

  result.bookState.status = abortSignal.aborted ? "failed" : "done";
  result.bookState.finishedAt = new Date().toISOString();
  result.bookState.durationMs = Date.now() - t0;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact writers
// ─────────────────────────────────────────────────────────────────────────────

async function writeChunkSample(outDir: string, slug: string, chunks: SemanticChunk[]): Promise<void> {
  const dir = path.join(outDir, "chunks");
  await fs.mkdir(dir, { recursive: true });
  const trimmed = chunks.map((c) => ({
    breadcrumb: c.breadcrumb,
    chapterIndex: c.chapterIndex,
    chapterTitle: c.chapterTitle,
    partN: c.partN,
    partTotal: c.partTotal,
    wordCount: c.wordCount,
    overlapText: c.overlapText ? c.overlapText.slice(0, 200) : undefined,
    textPreview: c.text.slice(0, 1500),
    textTotalChars: c.text.length,
  }));
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(trimmed, null, 2), "utf8");
}

async function writeConcepts(outDir: string, slug: string, concepts: AcceptedConcept[]): Promise<void> {
  const dir = path.join(outDir, "concepts");
  await fs.mkdir(dir, { recursive: true });
  const trimmed = concepts.map((c) => ({
    id: c.id,
    domain: c.domain,
    principle: c.principle,
    explanation: c.explanation,
    tags: c.tags,
    judgeScore: c.judgeScore,
    scoreBreakdown: c.scoreBreakdown,
    chapterIndex: c.chapterIndex,
    chapterTitle: c.chapterTitle,
    sourceQuote: c.sourceQuote.slice(0, 300),
    acceptedAt: c.acceptedAt,
  }));
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(trimmed, null, 2), "utf8");
}

async function appendRawEvents(outDir: string, slug: string, events: BookResult["events"]): Promise<void> {
  const file = path.join(outDir, "raw-events.jsonl");
  const lines = events.map((e) => JSON.stringify({ book: slug, ...e })).join("\n");
  if (lines.length === 0) return;
  await fs.appendFile(file, lines + "\n", "utf8");
}

function md(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function writeIndex(outDir: string, state: RunState): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Bibliary E2E Batch Library Report`);
  lines.push("");
  lines.push(`- **Run ID:** \`${state.runId}\``);
  lines.push(`- **Started:** ${state.startedAt}`);
  if (state.finishedAt) lines.push(`- **Finished:** ${state.finishedAt}`);
  lines.push(`- **Downloads:** \`${state.args.downloadsDir}\``);
  lines.push(`- **Extractor model:** \`${state.extractModel}\``);
  lines.push(`- **Judge model:** \`${state.judgeModel}\``);
  lines.push(`- **Score threshold:** ${state.args.scoreThreshold}`);
  lines.push(`- **Books found:** ${state.totalBooksFound} | **Processed:** ${Object.keys(state.books).length}`);
  lines.push("");

  const books = Object.values(state.books);
  const done = books.filter((b) => b.status === "done").length;
  const failed = books.filter((b) => b.status === "failed").length;
  const skipped = books.filter((b) => b.status === "skipped").length;
  const totalRaw = books.reduce((s, b) => s + (b.rawConcepts ?? 0), 0);
  const totalDedup = books.reduce((s, b) => s + (b.dedupedConcepts ?? 0), 0);
  const totalAccepted = books.reduce((s, b) => s + (b.acceptedConcepts ?? 0), 0);
  const totalRejected = books.reduce((s, b) => s + (b.rejectedConcepts ?? 0), 0);
  const totalErrors = books.reduce((s, b) => s + (b.errors?.length ?? 0), 0);

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Books done | ${done} |`);
  lines.push(`| Books failed | ${failed} |`);
  lines.push(`| Books skipped | ${skipped} |`);
  lines.push(`| Concepts raw | ${totalRaw} |`);
  lines.push(`| Concepts after intra-dedup | ${totalDedup} |`);
  lines.push(`| Concepts accepted (in Qdrant) | ${totalAccepted} |`);
  lines.push(`| Concepts rejected | ${totalRejected} |`);
  lines.push(`| Errors total | ${totalErrors} |`);
  lines.push("");

  lines.push(`## Per-book results`);
  lines.push("");
  lines.push(`| Book | Status | Chapters (proc/total) | Raw → Dedup → Accepted | Rejected | Errors | Duration |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const b of books) {
    const ch = `${b.processedChapters ?? 0}/${b.totalChapters ?? 0}`;
    const counts = `${b.rawConcepts ?? 0} → ${b.dedupedConcepts ?? 0} → ${b.acceptedConcepts ?? 0}`;
    const dur = b.durationMs ? `${(b.durationMs / 1000).toFixed(1)}s` : "—";
    lines.push(
      `| ${md(b.bookName)} | ${b.status} | ${ch} | ${counts} | ${b.rejectedConcepts ?? 0} | ${b.errors?.length ?? 0} | ${dur} |`,
    );
  }
  lines.push("");
  lines.push(`See [errors.md](./errors.md) for detailed pipeline errors and [by-domain.md](./by-domain.md) for thematic breakdown.`);
  lines.push("");
  await fs.writeFile(path.join(outDir, "index.md"), lines.join("\n"), "utf8");
}

async function writeErrors(outDir: string, state: RunState): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Pipeline errors — Run \`${state.runId}\``);
  lines.push("");
  const all: ErrorEntry[] = [];
  for (const b of Object.values(state.books)) {
    if (b.errors) all.push(...b.errors);
  }
  if (all.length === 0) {
    lines.push(`No errors recorded.`);
    await fs.writeFile(path.join(outDir, "errors.md"), lines.join("\n"), "utf8");
    return;
  }

  // Group by category
  const byCat = new Map<string, ErrorEntry[]>();
  for (const e of all) {
    const arr = byCat.get(e.category) ?? [];
    arr.push(e);
    byCat.set(e.category, arr);
  }
  const sorted = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length);

  lines.push(`## Summary by category`);
  lines.push("");
  lines.push(`| Category | Count |`);
  lines.push(`|---|---|`);
  for (const [cat, arr] of sorted) lines.push(`| \`${cat}\` | ${arr.length} |`);
  lines.push("");

  for (const [cat, arr] of sorted) {
    lines.push(`## ${cat} (${arr.length})`);
    lines.push("");
    lines.push(`| Book | Chapter | Message |`);
    lines.push(`|---|---|---|`);
    for (const e of arr) {
      const ch = e.chapterIndex !== undefined ? `${e.chapterIndex}: ${e.chapterTitle ?? ""}` : "—";
      lines.push(`| ${md(e.bookName)} | ${md(ch)} | ${md(e.message.slice(0, 250))} |`);
    }
    lines.push("");
  }
  await fs.writeFile(path.join(outDir, "errors.md"), lines.join("\n"), "utf8");
}

async function writeByDomain(outDir: string, state: RunState, allAccepted: AcceptedConcept[]): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Concepts by domain — Run \`${state.runId}\``);
  lines.push("");
  lines.push(`Total accepted: **${allAccepted.length}**`);
  lines.push("");

  const byDom = new Map<string, AcceptedConcept[]>();
  for (const c of allAccepted) {
    const arr = byDom.get(c.domain) ?? [];
    arr.push(c);
    byDom.set(c.domain, arr);
  }
  const sorted = [...byDom.entries()].sort((a, b) => b[1].length - a[1].length);

  lines.push(`| Domain | Count | Top score | Avg score |`);
  lines.push(`|---|---|---|---|`);
  for (const [dom, arr] of sorted) {
    const top = Math.max(...arr.map((c) => c.judgeScore));
    const avg = arr.reduce((s, c) => s + c.judgeScore, 0) / arr.length;
    lines.push(`| **${dom}** | ${arr.length} | ${top.toFixed(2)} | ${avg.toFixed(2)} |`);
  }
  lines.push("");

  for (const [dom, arr] of sorted) {
    lines.push(`## ${dom} (${arr.length})`);
    lines.push("");
    const top3 = arr.slice().sort((a, b) => b.judgeScore - a.judgeScore).slice(0, 3);
    for (const c of top3) {
      lines.push(`### ${c.principle} *(score ${c.judgeScore.toFixed(2)})*`);
      lines.push("");
      lines.push(`${c.explanation.slice(0, 500)}`);
      lines.push("");
      lines.push(`*tags:* \`${c.tags.join(", ")}\` — *book:* ${c.bookTitle} — *chapter:* ${c.chapterTitle}`);
      lines.push("");
    }
    if (arr.length > 3) lines.push(`*... and ${arr.length - 3} more in concepts/*.json*`);
    lines.push("");
  }
  await fs.writeFile(path.join(outDir, "by-domain.md"), lines.join("\n"), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Library import (File-System First: original + book.md per book)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Возвращает primary domain (домен с максимумом принятых концептов).
 * Используется для группировки в каталоге и для frontmatter.domain.
 */
function pickPrimaryDomain(accepted: AcceptedConcept[]): string | undefined {
  if (accepted.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const c of accepted) counts.set(c.domain, (counts.get(c.domain) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Импортирует книгу в проектное хранилище:
 *   data/library/{slug}/original.{ext}
 *   data/library/{slug}/book.md   <-- frontmatter обогащён результатами кристаллизации
 *
 * Все картинки уже встроены в book.md как Base64 reference links (через md-converter).
 * Идемпотентна -- повторный вызов перезаписывает .md (например, после доп. кристаллизации).
 *
 * CPU-операция: безопасно вызывать сразу после processBook (GPU освобождена).
 */
async function importBookToLibrary(
  book: BookFileSummary,
  bookState: BookState,
  accepted: AcceptedConcept[],
  libraryRoot: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; bookDir: string; warning?: string }> {
  const slug = slugify(book.fileName);
  const bookDir = path.join(libraryRoot, slug);
  try {
    await fs.mkdir(bookDir, { recursive: true });
    const originalDest = path.join(bookDir, `original${path.extname(book.fileName)}`);
    /* Копируем оригинал только если ещё не скопирован (ускоряет resume). */
    try {
      await fs.access(originalDest);
    } catch {
      await fs.copyFile(book.absPath, originalDest);
    }

    const converted = await convertBookToMarkdown(book.absPath, { ocrEnabled: true, signal });

    /* Обогащаем frontmatter результатами кристаллизации. */
    const tagSet = new Set<string>();
    let totalScore = 0;
    for (const c of accepted) {
      for (const t of c.tags ?? []) tagSet.add(t);
      totalScore += c.judgeScore;
    }
    const enrichedMeta: BookCatalogMeta = {
      ...converted.meta,
      domain: pickPrimaryDomain(accepted),
      tags: tagSet.size > 0 ? [...tagSet].slice(0, 20) : undefined,
      conceptsExtracted: bookState.rawConcepts ?? 0,
      conceptsAccepted: accepted.length,
      qualityScore: accepted.length > 0 ? totalScore / accepted.length : 0,
      status: bookState.status === "done" ? "indexed" : "failed",
    };
    const finalMd = replaceFrontmatter(converted.markdown, enrichedMeta);
    await fs.writeFile(path.join(bookDir, "book.md"), finalMd, "utf8");
    return { ok: true, bookDir };
  } catch (e) {
    return { ok: false, bookDir, warning: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`\n${COLOR.bold}=== Bibliary E2E Batch Library ===${COLOR.reset}`);
  console.log(`LM Studio   : ${HTTP_URL}`);
  console.log(`Qdrant      : ${QDRANT_URL_ENV}`);
  console.log(`Downloads   : ${args.downloadsDir}`);
  console.log(`Max size    : ${args.maxSizeMb} MB`);
  console.log(`Max books   : ${args.maxBooks ?? "no limit"}`);
  console.log(`Max chap.   : ${args.maxChapters ?? "no limit"}`);
  console.log(`Threshold   : ${args.scoreThreshold}`);
  console.log(`Restart     : ${args.restart}\n`);

  // ── Pre-flight ────────────────────────────────────────────────────────────
  console.log(`${COLOR.cyan}[pre-flight]${COLOR.reset} probing services...`);
  const lm = await probeLmStudio();
  await probeQdrant();
  await probeDownloads(args.downloadsDir);

  // Pick models (extractor + judge — same caskade as e2e-full-mvp)
  const TAG_PRIORITY: ModelTag[] = ["flagship", "tool-capable-coder", "non-thinking-instruct", "small-fast"];
  const HINTS = ["qwen3.6", "qwen3-coder", "mistral-small", "qwen3-14b", "qwen3-4b-2507"];
  const extractModel = await pickModelByTags(lm.models, TAG_PRIORITY, HINTS);
  const judgeModel = await pickModelByTags(lm.models, TAG_PRIORITY, HINTS);
  if (!extractModel || !judgeModel) fatal(`No suitable model picked (loaded: ${lm.models.join(", ")})`);
  console.log(`${COLOR.cyan}[pre-flight]${COLOR.reset} extractor=${extractModel}`);
  console.log(`${COLOR.cyan}[pre-flight]${COLOR.reset} judge    =${judgeModel}`);

  // ── Probe books ───────────────────────────────────────────────────────────
  console.log(`\n${COLOR.cyan}[probe]${COLOR.reset} scanning ${args.downloadsDir}...`);
  const allFound = await probeBooks(args.downloadsDir, 4, false);
  const maxBytes = args.maxSizeMb * 1024 * 1024;
  let filtered = allFound
    .filter((b) => b.sizeBytes <= maxBytes)
    .filter((b) => ["pdf", "epub", "fb2", "txt", "docx"].includes(b.ext));
  if (args.includePattern) {
    const before = filtered.length;
    filtered = filtered.filter((b) => args.includePattern!.test(b.fileName));
    info(`  --include-pattern matched ${filtered.length}/${before} books`);
  }
  filtered.sort((a, b) => a.sizeBytes - b.sizeBytes); /* small → large for fast feedback */
  console.log(`${COLOR.cyan}[probe]${COLOR.reset} found ${allFound.length} files, ${filtered.length} eligible (≤${args.maxSizeMb}MB, supported)`);
  const skippedTooBig = allFound.filter((b) => b.sizeBytes > maxBytes);
  if (skippedTooBig.length > 0) info(`  skipped ${skippedTooBig.length} oversized files (max ${args.maxSizeMb}MB)`);

  const books = args.maxBooks ? filtered.slice(0, args.maxBooks) : filtered;
  if (books.length === 0) fatal(`No eligible books in ${args.downloadsDir}`);

  // ── Output dir & state ────────────────────────────────────────────────────
  const outRoot = path.resolve(process.cwd(), "release", "e2e-report");
  await fs.mkdir(outRoot, { recursive: true });

  // Try to resume from latest run (if --restart not specified)
  let runId: string;
  let outDir: string;
  let state: RunState | null = null;
  if (!args.restart) {
    try {
      const dirs = await fs.readdir(outRoot, { withFileTypes: true });
      const recent = dirs
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const candidate of recent) {
        const stateFile = path.join(outRoot, candidate, "state.json");
        const loaded = await loadState(stateFile);
        if (loaded && !loaded.finishedAt) {
          state = loaded;
          runId = loaded.runId;
          outDir = path.join(outRoot, runId);
          console.log(`${COLOR.yellow}[resume]${COLOR.reset} continuing run ${runId} (${Object.keys(loaded.books).filter((k) => loaded.books[k].status === "done").length} done)`);
          break;
        }
      }
    } catch {
      /* no previous runs, start fresh */
    }
  }
  if (!state) {
    runId = timestampDir();
    outDir = path.join(outRoot, runId);
    await fs.mkdir(outDir, { recursive: true });
    state = {
      runId,
      startedAt: new Date().toISOString(),
      args,
      extractModel,
      judgeModel,
      totalBooksFound: books.length,
      books: {},
    };
  } else {
    runId = state.runId;
    outDir = path.join(outRoot, runId);
  }
  const stateFile = path.join(outDir, "state.json");
  console.log(`${COLOR.cyan}[output]${COLOR.reset} ${outDir}\n`);

  // ── Graceful Ctrl+C ───────────────────────────────────────────────────────
  const abortCtl = new AbortController();
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) {
      console.log(`\n${COLOR.red}Force quit.${COLOR.reset}`);
      process.exit(130);
    }
    interrupted = true;
    console.log(`\n${COLOR.yellow}[SIGINT] finishing current book then saving state…${COLOR.reset}`);
    abortCtl.abort();
  });

  // ── Per-book loop ─────────────────────────────────────────────────────────
  const allAccepted: AcceptedConcept[] = [];
  // Pre-load already-accepted from disk if resuming (so by-domain stays complete)
  for (const k of Object.keys(state.books)) {
    if (state.books[k].status === "done") {
      try {
        const slug = slugify(state.books[k].bookName);
        const file = path.join(outDir, "concepts", `${slug}.json`);
        const txt = await fs.readFile(file, "utf8");
        const arr = JSON.parse(txt) as AcceptedConcept[];
        allAccepted.push(...arr);
      } catch {
        /* ignore — file may not exist yet */
      }
    }
  }

  let processed = 0;
  for (let i = 0; i < books.length; i++) {
    if (abortCtl.signal.aborted) break;
    const book = books[i];
    const key = book.absPath;
    const prev = state.books[key];
    if (prev && (prev.status === "done" || prev.status === "failed") && !args.restart) {
      console.log(
        `[${i + 1}/${books.length}] ${COLOR.dim}skip ${book.fileName} (${prev.status} previously)${COLOR.reset}`,
      );
      continue;
    }

    const sizeMb = (book.sizeBytes / 1024 / 1024).toFixed(1);
    console.log(
      `\n[${i + 1}/${books.length}] ${COLOR.bold}${book.fileName}${COLOR.reset} ${COLOR.dim}(${book.ext}, ${sizeMb}MB)${COLOR.reset}`,
    );

    state.books[key] = {
      bookPath: book.absPath,
      bookName: book.fileName,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    await saveState(stateFile, state);

    let result: BookResult;
    try {
      result = await processBook(book, args, extractModel, judgeModel, abortCtl.signal, null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ${COLOR.red}FATAL processBook:${COLOR.reset} ${msg}`);
      state.books[key] = {
        ...state.books[key],
        status: "failed",
        finishedAt: new Date().toISOString(),
        errors: [{ category: classifyError(msg), bookName: book.fileName, message: msg }],
      };
      await saveState(stateFile, state);
      continue;
    }

    state.books[key] = result.bookState;
    const slug = slugify(book.fileName);
    await writeChunkSample(outDir, slug, result.chunkSample);
    await writeConcepts(outDir, slug, result.accepted);
    await appendRawEvents(outDir, slug, result.events);
    allAccepted.push(...result.accepted);

    /* Library import — CPU-операция, безопасно после processBook (GPU свободна).
       Импортируем только если парсинг прошёл (status !== "failed" из-за parser-failed).
       Книги, упавшие на parsing stage, не попадают в каталог -- они нечитаемы. */
    if (!args.skipLibrary && (result.bookState.status === "done" || (result.bookState.totalChapters ?? 0) > 0)) {
      const libImport = await importBookToLibrary(book, result.bookState, result.accepted, args.libraryRoot, abortCtl.signal);
      if (libImport.ok) {
        process.stdout.write(`  ${COLOR.dim}library: imported -> ${path.relative(process.cwd(), libImport.bookDir)}${COLOR.reset}\n`);
      } else {
        process.stdout.write(`  ${COLOR.yellow}library: import failed -- ${libImport.warning}${COLOR.reset}\n`);
      }
    }

    // Re-render aggregates after each book (so user can peek mid-run)
    await writeIndex(outDir, state);
    await writeErrors(outDir, state);
    await writeByDomain(outDir, state, allAccepted);
    await saveState(stateFile, state);

    const dur = ((result.bookState.durationMs ?? 0) / 1000).toFixed(1);
    const statColor = result.bookState.status === "done" ? COLOR.green : COLOR.yellow;
    console.log(
      `  ${statColor}${result.bookState.status}${COLOR.reset} in ${dur}s — accepted ${result.bookState.acceptedConcepts}/${result.bookState.rawConcepts} raw, errors ${result.bookState.errors?.length ?? 0}`,
    );
    processed++;
  }

  state.finishedAt = new Date().toISOString();
  await writeIndex(outDir, state);
  await writeErrors(outDir, state);
  await writeByDomain(outDir, state, allAccepted);
  await saveState(stateFile, state);

  console.log(`\n${COLOR.bold}=== DONE ===${COLOR.reset}`);
  console.log(`Processed this session : ${processed} / ${books.length}`);
  console.log(`Total accepted concepts: ${allAccepted.length}`);
  console.log(`Report                 : ${path.relative(process.cwd(), outDir)}`);
  console.log(`  - index.md     (per-book summary)`);
  console.log(`  - by-domain.md (thematic breakdown)`);
  console.log(`  - errors.md    (pipeline errors)`);
  console.log(`  - chunks/      (sample chunks JSON)`);
  console.log(`  - concepts/    (accepted concepts JSON)`);
  console.log(`  - raw-events.jsonl (full event stream)\n`);

  if (interrupted) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n${COLOR.red}${COLOR.bold}UNHANDLED:${COLOR.reset} ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
