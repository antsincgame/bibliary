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
import {
  convertBookToMarkdown,
  replaceFrontmatter,
  upsertEvaluatorReasoning,
} from "../electron/lib/library/md-converter.js";
import type { BookCatalogMeta } from "../electron/lib/library/types.js";
import { upsertBook, setBookStatus, getKnownSha256s } from "../electron/lib/library/cache-db.js";
import { buildSurrogate } from "../electron/lib/library/surrogate-builder.js";
import { evaluateBook, pickEvaluatorModel, type BookEvaluation } from "../electron/lib/library/book-evaluator.js";
import {
  chunkChapter,
  extractChapterConcepts,
  dedupChapterConcepts,
  judgeAndAccept,
  ACCEPTED_COLLECTION,
  assertValidCollectionName,
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
  /** Iter 7: тематическая Qdrant-коллекция (default ACCEPTED_COLLECTION). */
  targetCollection: string;
  /** Iter 7: порог quality_score; ниже -- crystallization пропускается. */
  qualityThreshold: number;
  /** Iter 7: пропустить Pre-flight Evaluation (для smoke без LLM). */
  skipEvaluate: boolean;
  /** Iter 7: пропустить Crystallization (только parse + evaluate + import). */
  skipCrystallize: boolean;
  /** Iter 7: модель-эпистемолог (override pickEvaluatorModel). */
  evaluatorModel: string | null;
}

function printHelp(): void {
  console.log(`
Bibliary E2E Batch Library -- full pipeline tester (Iter 7)

USAGE: ts-node scripts/e2e-batch-library.ts [OPTIONS]

PIPELINE OPTIONS:
  --downloads <dir>          Source folder with books (default: ~/Downloads)
  --max-size-mb <n>          Skip files larger than N MB (default: 50)
  --include-pattern <regex>  Filter by filename (case-insensitive regex)
  --max-books <n>            Cap number of books (default: no limit)
  --max-chapters <n>         Cap chapters per book (default: all)

EVALUATION:
  --skip-evaluate            Skip pre-flight LLM quality evaluation
  --evaluator-model <id>     Override evaluator model id (default: auto-pick)
  --quality-threshold <n>    Min quality_score for crystallization (default: 50)

CRYSTALLIZATION:
  --skip-crystallize         Parse + evaluate only, no Qdrant writes
  --target-collection <id>   Qdrant collection name (default: dataset-accepted-concepts)
  --score-threshold <n>      Judge cosine score threshold (default: 0.6)
  --prompt <auto|mechanicus|cognitive>  Concept-extraction prompt key

LIBRARY:
  --library-root <dir>       Where to write data/library/{slug}/ (default: ./data/library)
  --skip-library             Don't write to library/ or SQLite (dry-run)

CONTROL:
  --restart                  Discard previous run state, start fresh
  --help                     Show this help

EXIT CODE: number of books with overall=FAIL verdict (0 = all green).
`.trim());
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
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
    targetCollection: get("--target-collection") ?? ACCEPTED_COLLECTION,
    qualityThreshold: num("--quality-threshold", 50) ?? 50,
    skipEvaluate: argv.includes("--skip-evaluate"),
    skipCrystallize: argv.includes("--skip-crystallize"),
    evaluatorModel: get("--evaluator-model"),
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

/* Iter 7: совмещаем legacy-семантику ("running"/"done"/"skipped" -- для логов
   тестового прогона) с реальными жизненными статусами SQLite-каталога
   ("imported"/"evaluated"/"indexed"). Это позволяет writeIndex считать книги
   на каждой стадии конвейера без отдельных enum'ов. */
type BookStatus =
  | "pending" | "running" | "skipped" | "duplicate"
  | "imported" | "evaluated" | "indexed" | "done" | "failed";
type StageVerdict = "PASS" | "FAIL" | "SKIP";

/** Per-book test report: 4 этапа = 4 assertion-а, как просил юзер ("сколько книг — столько тестов"). */
interface StageReport {
  parse: StageVerdict;
  evaluate: StageVerdict;
  crystallize: StageVerdict;
  persist: StageVerdict;
  /** Итоговый вердикт: PASS если все non-SKIP -- PASS; FAIL если хоть одна FAIL. */
  overall: StageVerdict;
}

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
  /* Iter 7 -- Pre-flight Evaluation results. */
  bookId?: string;
  sha256?: string;
  wordCount?: number;
  qualityScore?: number;
  domain?: string;
  isFictionOrWater?: boolean;
  evaluatorModel?: string;
  evaluatorReasoningChars?: number;
  evaluationVerdict?: string;
  /* Iter 7 -- per-stage test verdicts. */
  stages?: StageReport;
  /** Если crystallization была пропущена -- объяснение. */
  crystallizeSkippedReason?: string;
  /** Если книга оказалась SHA-256 дубликатом другой -- id оригинала. */
  duplicateOf?: string;
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

/**
 * Atomic state persistence with Windows-safe retry.
 *
 * fs.rename on Windows throws EPERM/EBUSY when:
 *   - antivirus scans the .tmp file the moment we finished writing it
 *   - indexing service holds a read lock
 *   - OneDrive sync is mid-upload
 *
 * All three are transient. Exponential backoff (up to ~1.5s total) handles
 * >99% of cases. Falls back to direct write-in-place if rename persistently
 * fails — accepts the small risk of partial write on crash vs. losing the
 * entire 30-minute batch progress.
 */
async function saveState(stateFile: string, state: RunState): Promise<void> {
  const tmp = `${stateFile}.tmp`;
  const payload = JSON.stringify(state, null, 2);

  try {
    await fs.writeFile(tmp, payload, "utf8");
  } catch (e) {
    /* If we can't even write the tmp file, try direct write as last resort. */
    await fs.writeFile(stateFile, payload, "utf8");
    return;
  }

  /* Exponential backoff retry: 50ms, 100ms, 200ms, 400ms, 800ms = ~1.55s max. */
  const delays = [50, 100, 200, 400, 800];
  let lastErr: unknown = null;
  for (const delay of delays) {
    try {
      await fs.rename(tmp, stateFile);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code ?? "";
      /* Only retry on known-transient Windows locks. Real errors (EACCES, ENOENT
         on the source) should fail fast. */
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /* All retries exhausted. Fall back to non-atomic write-in-place.
     Better than losing the whole batch to an antivirus scan. */
  try {
    await fs.writeFile(stateFile, payload, "utf8");
    await fs.unlink(tmp).catch(() => { /* ignore cleanup failure */ });
  } catch {
    /* If even in-place write fails, propagate the original rename error. */
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
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

/* Iter 7: вычисляет primary domain (с максимумом принятых концептов) -- для frontmatter. */
function pickPrimaryDomainFromAccepted(accepted: AcceptedConcept[]): string | undefined {
  if (accepted.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const c of accepted) counts.set(c.domain, (counts.get(c.domain) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Iter 7: новый processBook = полный pipeline.
 *
 * Stages (каждый = test-assertion в per-book report):
 *   1. PARSE+IMPORT   convertBookToMarkdown -> book.md + SQLite('imported')
 *   2. EVALUATE       buildSurrogate -> evaluateBook -> SQLite('evaluated')
 *   3. GUARD          quality_score >= threshold && !is_fiction_or_water
 *   4. CRYSTALLIZE    chunk -> extract -> dedup -> judge -> Qdrant(targetCollection)
 *   5. PERSIST        SQLite('indexed', conceptsAccepted, conceptsExtracted)
 *
 * Каждая стадия возвращает PASS/FAIL/SKIP. Итог: per-book test verdict.
 */
async function processBook(
  book: BookFileSummary,
  args: CliArgs,
  extractModel: string,
  judgeModel: string,
  evaluatorModel: string | null,
  abortSignal: AbortSignal,
  promptsDir: string | null,
): Promise<BookResult> {
  const stages: StageReport = { parse: "FAIL", evaluate: "SKIP", crystallize: "SKIP", persist: "SKIP", overall: "FAIL" };
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
      stages,
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

  // ── Stage 1: PARSE + IMPORT ─────────────────────────────────────────────
  /* convertBookToMarkdown делает parseBook + chapter-split + image-extract +
     buildFrontmatter + Markdown body. Это CPU-heavy, GPU свободна.
     Per-book timeout 8 мин: pdfjs на повреждённых PDF может зацикливаться
     на ретраях XRef parse, не реагируя на opts.signal (внутренний worker).
     Жертвуем 1-2 битыми книгами ради того чтобы batch не висел часами. */
  const PARSE_TIMEOUT_MS = 8 * 60 * 1000;
  let converted;
  try {
    const parseCtl = new AbortController();
    const timer = setTimeout(() => parseCtl.abort(), PARSE_TIMEOUT_MS);
    const onUpstreamAbort = (): void => parseCtl.abort();
    abortSignal?.addEventListener("abort", onUpstreamAbort);
    try {
      converted = await Promise.race([
        convertBookToMarkdown(book.absPath, { ocrEnabled: isOcrSupported(), signal: parseCtl.signal }),
        new Promise<never>((_, reject) => {
          parseCtl.signal.addEventListener("abort", () =>
            reject(new Error(`parse timeout > ${PARSE_TIMEOUT_MS / 1000}s (likely corrupt PDF)`)),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onUpstreamAbort);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushErr("parser-failed", msg);
    result.bookState.status = "failed";
    result.bookState.finishedAt = new Date().toISOString();
    result.bookState.durationMs = Date.now() - t0;
    return result;
  }

  result.bookState.bookId = converted.meta.id;
  result.bookState.sha256 = converted.meta.sha256;
  result.bookState.wordCount = converted.meta.wordCount;
  result.bookState.totalChapters = converted.chapters.length;

  if (converted.chapters.length === 0) {
    pushErr("parser-failed", "convertBookToMarkdown returned 0 chapters (parser+OCR exhausted)");
    result.bookState.status = "failed";
    result.bookState.finishedAt = new Date().toISOString();
    result.bookState.durationMs = Date.now() - t0;
    return result;
  }

  /* Запись в data/library + SQLite (даже в sukhom прогоне -- skipLibrary=true пропускает).
     SHA-256 дедуп: если книга с таким контентом уже импортирована -- помечаем
     как duplicate, не перезаписываем (book.md уже на диске под старым slug). */
  let mdPath: string | null = null;
  let isDuplicate = false;
  if (!args.skipLibrary) {
    const known = getKnownSha256s();
    const dupId = known.get(converted.meta.sha256);
    if (dupId) {
      isDuplicate = true;
      result.bookState.duplicateOf = dupId;
      pushEv("library.duplicate", { ofId: dupId, sha256: converted.meta.sha256 });
    } else {
      const slug = slugify(book.fileName);
      const bookDir = path.join(args.libraryRoot, slug);
      try {
        await fs.mkdir(bookDir, { recursive: true });
        const originalDest = path.join(bookDir, `original${path.extname(book.fileName)}`);
        try { await fs.access(originalDest); } catch { await fs.copyFile(book.absPath, originalDest); }
        mdPath = path.join(bookDir, "book.md");
        await fs.writeFile(mdPath, converted.markdown, "utf8");
        upsertBook(converted.meta, mdPath);
      } catch (e) {
        pushErr("unknown", `library import failed: ${e instanceof Error ? e.message : String(e)}`);
        /* Не валим тест -- продолжаем, но persist-stage будет FAIL. */
      }
    }
  }
  stages.parse = "PASS";

  const bookTitle = converted.meta.title;

  /* Iter 7 fix: SHA-256 duplicate -- ничего не делаем дальше, книга уже в каталоге.
     Все стадии маркируем SKIP с причиной 'duplicate'. */
  if (isDuplicate) {
    stages.evaluate = "SKIP";
    stages.crystallize = "SKIP";
    stages.persist = "SKIP";
    result.bookState.crystallizeSkippedReason = "duplicate";
    result.bookState.status = "duplicate";
    result.bookState.finishedAt = new Date().toISOString();
    result.bookState.durationMs = Date.now() - t0;
    stages.overall = "PASS";
    return result;
  }

  // ── Stage 2: EVALUATE (Pre-flight) ──────────────────────────────────────
  let evaluation: BookEvaluation | null = null;
  if (args.skipEvaluate) {
    stages.evaluate = "SKIP";
    result.bookState.crystallizeSkippedReason = "evaluate-disabled";
  } else {
    try {
      const surrogate = buildSurrogate(converted.chapters);
      pushEv("evaluate.surrogate", { totalWords: surrogate.composition.totalWords, nodalSlices: surrogate.composition.nodalSlices.length });
      const evalRes = await evaluateBook(surrogate.surrogate, {
        model: evaluatorModel ?? undefined,
        signal: abortSignal,
      });
      pushEv("evaluate.result", { warnings: evalRes.warnings, model: evalRes.model, hasReasoning: !!evalRes.reasoning });

      if (evalRes.evaluation) {
        evaluation = evalRes.evaluation;
        result.bookState.qualityScore = evaluation.quality_score;
        result.bookState.domain = evaluation.domain;
        result.bookState.isFictionOrWater = evaluation.is_fiction_or_water;
        result.bookState.evaluatorModel = evalRes.model;
        result.bookState.evaluatorReasoningChars = evalRes.reasoning?.length ?? 0;
        result.bookState.evaluationVerdict = evaluation.verdict_reason;

        /* Перезаписываем book.md с обогащённым frontmatter + reasoning блок. */
        if (!args.skipLibrary && mdPath) {
          const enrichedMeta: BookCatalogMeta = {
            ...converted.meta,
            titleEn: evaluation.title_en,
            authorEn: evaluation.author_en,
            domain: evaluation.domain,
            tags: evaluation.tags,
            qualityScore: evaluation.quality_score,
            conceptualDensity: evaluation.conceptual_density,
            originality: evaluation.originality,
            isFictionOrWater: evaluation.is_fiction_or_water,
            verdictReason: evaluation.verdict_reason,
            evaluatorReasoning: evalRes.reasoning ?? undefined,
            evaluatorModel: evalRes.model,
            evaluatedAt: new Date().toISOString(),
            status: "evaluated",
          };
          try {
            const newMd = upsertEvaluatorReasoning(replaceFrontmatter(converted.markdown, enrichedMeta), evalRes.reasoning ?? null);
            await fs.writeFile(mdPath, newMd, "utf8");
            upsertBook(enrichedMeta, mdPath);
          } catch (e) {
            pushErr("unknown", `evaluator persist failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        stages.evaluate = "PASS";
      } else {
        pushErr("unknown", `evaluator: no parseable JSON (warnings: ${evalRes.warnings.slice(0, 3).join("; ")})`);
        stages.evaluate = "FAIL";
        result.bookState.crystallizeSkippedReason = "evaluate-failed";
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushErr(classifyError(msg) === "aborted" ? "aborted" : "unknown", `evaluate: ${msg}`);
      stages.evaluate = "FAIL";
      result.bookState.crystallizeSkippedReason = "evaluate-error";
    }
  }

  // ── Stage 3: GUARD ──────────────────────────────────────────────────────
  /* Без оценки или с низким quality_score crystallize пропускается -- НЕ
     тратим LLM на мусор. Точно ту же логику использует прод-batch handler. */
  let canCrystallize = !args.skipCrystallize && stages.parse === "PASS";
  if (canCrystallize && !args.skipEvaluate) {
    if (!evaluation) {
      canCrystallize = false;
      result.bookState.crystallizeSkippedReason = "no-evaluation";
    } else if (evaluation.quality_score < args.qualityThreshold) {
      canCrystallize = false;
      result.bookState.crystallizeSkippedReason = `quality ${evaluation.quality_score} < ${args.qualityThreshold}`;
    } else if (evaluation.is_fiction_or_water) {
      canCrystallize = false;
      result.bookState.crystallizeSkippedReason = "fiction-or-water";
    }
  }
  if (args.skipCrystallize) {
    result.bookState.crystallizeSkippedReason = "crystallize-disabled";
  }

  // ── Stage 4: CRYSTALLIZE ────────────────────────────────────────────────
  if (canCrystallize) {
    if (mdPath) setBookStatus(converted.meta.id, "crystallizing");
    const chaptersToProcess = args.maxChapters ? converted.chapters.slice(0, args.maxChapters) : converted.chapters;
    let anyAccepted = false;

    for (let chIdx = 0; chIdx < chaptersToProcess.length; chIdx++) {
      if (abortSignal.aborted) { pushErr("aborted", "interrupted by user"); break; }
      const ch = chaptersToProcess[chIdx];
      const chapterTitle = ch.title || `Chapter ${chIdx + 1}`;

      /* chunkChapter ждёт ParserSection -- собираем из ConvertedChapter. */
      const section = { title: ch.title, paragraphs: ch.paragraphs };
      let chunks: SemanticChunk[];
      try {
        chunks = await chunkChapter({ section, chapterIndex: chIdx, bookTitle, bookSourcePath: book.absPath, signal: abortSignal });
      } catch (e) {
        pushErr("chunker-failed", e instanceof Error ? e.message : String(e), chIdx, chapterTitle);
        continue;
      }
      if (chunks.length === 0) { pushErr("chunker-failed", "0 chunks produced", chIdx, chapterTitle); continue; }
      if (result.chunkSample.length < SAMPLE_CHUNKS_PER_BOOK) {
        result.chunkSample.push(...chunks.slice(0, SAMPLE_CHUNKS_PER_BOOK - result.chunkSample.length));
      }

      const llmExtract = await buildLlm(extractModel, "extractor", abortSignal);
      const resolvedPromptKey: "mechanicus" | "cognitive" | undefined =
        args.promptKey === "auto"
          ? ((await getModelProfile(extractModel)).source === "thinking-heavy" ? "cognitive" : "mechanicus")
          : args.promptKey;
      let extracted;
      try {
        extracted = await extractChapterConcepts({
          chunks, promptsDir, promptKey: resolvedPromptKey,
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
      result.bookState.rawConcepts! += extracted.conceptsTotal.length;
      if (extracted.conceptsTotal.length === 0) {
        pushErr("extractor-zero-concepts", `0 valid concepts from ${chunks.length} chunks`, chIdx, chapterTitle);
        result.bookState.processedChapters!++;
        continue;
      }

      let deduped;
      try {
        deduped = await dedupChapterConcepts({
          concepts: extracted.conceptsTotal, bookSourcePath: book.absPath, bookTitle,
          chapterIndex: chIdx, chapterTitle,
          onEvent: (ev: IntraDedupEvent) => pushEv("dedup", ev),
        });
      } catch (e) {
        pushErr("unknown", `dedup: ${e instanceof Error ? e.message : String(e)}`, chIdx, chapterTitle);
        continue;
      }
      result.bookState.dedupedConcepts! += deduped.concepts.length;

      const llmJudge = await buildLlm(judgeModel, "judge", abortSignal);
      let judged;
      try {
        judged = await judgeAndAccept({
          concepts: deduped.concepts, promptsDir,
          scoreThreshold: args.scoreThreshold,
          targetCollection: args.targetCollection,
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
      if (judged.accepted.length > 0) anyAccepted = true;

      process.stdout.write(
        `    ${COLOR.dim}ch ${chIdx + 1}/${chaptersToProcess.length}: ${extracted.conceptsTotal.length} raw → ${deduped.concepts.length} dedup → ${judged.accepted.length} accepted${COLOR.reset}\n`,
      );
    }
    stages.crystallize = anyAccepted ? "PASS" : "FAIL";
  }

  // ── Stage 5: PERSIST (final SQLite update) ──────────────────────────────
  if (mdPath) {
    try {
      const finalStatus =
        stages.crystallize === "PASS" ? "indexed"
        : stages.crystallize === "FAIL" ? "failed"
        : stages.evaluate === "PASS" ? "evaluated"
        : "imported";
      setBookStatus(converted.meta.id, finalStatus, {
        conceptsAccepted: result.bookState.acceptedConcepts ?? 0,
        conceptsExtracted: result.bookState.rawConcepts ?? 0,
      });
      /* Если кристаллизация дала концепты -- ещё раз обогащаем frontmatter
         primary-domain'ом из принятых, тегами, счётчиками. Это нужно для
         каталога: книга должна показывать accepted/extracted на карточке. */
      if (stages.crystallize === "PASS") {
        const tagSet = new Set<string>();
        for (const c of result.accepted) for (const t of c.tags ?? []) tagSet.add(t);
        const finalMeta: BookCatalogMeta = {
          ...converted.meta,
          titleEn: evaluation?.title_en,
          authorEn: evaluation?.author_en,
          domain: pickPrimaryDomainFromAccepted(result.accepted) ?? evaluation?.domain,
          tags: tagSet.size > 0 ? [...tagSet].slice(0, 20) : evaluation?.tags,
          qualityScore: evaluation?.quality_score,
          conceptualDensity: evaluation?.conceptual_density,
          originality: evaluation?.originality,
          isFictionOrWater: evaluation?.is_fiction_or_water,
          verdictReason: evaluation?.verdict_reason,
          evaluatorModel: result.bookState.evaluatorModel,
          evaluatedAt: result.bookState.evaluatorModel ? new Date().toISOString() : undefined,
          conceptsExtracted: result.bookState.rawConcepts,
          conceptsAccepted: result.bookState.acceptedConcepts,
          status: finalStatus,
        };
        upsertBook(finalMeta, mdPath);
      }
      stages.persist = "PASS";
    } catch (e) {
      pushErr("unknown", `persist: ${e instanceof Error ? e.message : String(e)}`);
      stages.persist = "FAIL";
    }
  } else if (args.skipLibrary) {
    stages.persist = "SKIP";
  } else {
    stages.persist = "FAIL"; /* mdPath не получился -- import сломался выше. */
  }

  /* Итоговый вердикт: PASS если все non-SKIP стадии PASS, иначе FAIL. */
  const verdicts = [stages.parse, stages.evaluate, stages.crystallize, stages.persist];
  const hasFailNonSkip = verdicts.some((v) => v === "FAIL");
  stages.overall = hasFailNonSkip ? "FAIL" : "PASS";

  /* Iter 7: status зеркалит реальный жизненный цикл -- максимально дальний
     уровень, до которого книга дошла. Это упрощает аналитику в writeIndex. */
  if (abortSignal.aborted) {
    result.bookState.status = "failed";
  } else if (stages.crystallize === "PASS") {
    result.bookState.status = "indexed";
  } else if (stages.crystallize === "FAIL") {
    result.bookState.status = "failed";
  } else if (stages.evaluate === "PASS") {
    result.bookState.status = "evaluated";
  } else if (stages.parse === "PASS") {
    result.bookState.status = "imported";
  } else {
    result.bookState.status = "failed";
  }
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
  lines.push(`- **Library root:** \`${state.args.libraryRoot}\``);
  lines.push(`- **Target collection:** \`${state.args.targetCollection}\``);
  lines.push(`- **Extractor model:** \`${state.extractModel}\``);
  lines.push(`- **Judge model:** \`${state.judgeModel}\``);
  lines.push(`- **Quality threshold:** ${state.args.qualityThreshold}`);
  lines.push(`- **Score threshold:** ${state.args.scoreThreshold}`);
  lines.push(`- **Books found:** ${state.totalBooksFound} | **Processed:** ${Object.keys(state.books).length}`);
  lines.push("");

  const books = Object.values(state.books);
  const indexed = books.filter((b) => b.status === "indexed").length;
  const evaluated = books.filter((b) => b.status === "evaluated").length;
  const importedOnly = books.filter((b) => b.status === "imported").length;
  const failed = books.filter((b) => b.status === "failed").length;
  const skipped = books.filter((b) => b.status === "skipped").length;
  const totalRaw = books.reduce((s, b) => s + (b.rawConcepts ?? 0), 0);
  const totalDedup = books.reduce((s, b) => s + (b.dedupedConcepts ?? 0), 0);
  const totalAccepted = books.reduce((s, b) => s + (b.acceptedConcepts ?? 0), 0);
  const totalRejected = books.reduce((s, b) => s + (b.rejectedConcepts ?? 0), 0);
  const totalErrors = books.reduce((s, b) => s + (b.errors?.length ?? 0), 0);
  const tests = {
    pass: books.filter((b) => b.stages?.overall === "PASS").length,
    fail: books.filter((b) => b.stages?.overall === "FAIL").length,
    skip: books.filter((b) => !b.stages || b.stages.overall === "SKIP").length,
  };

  lines.push(`## Test summary (E2E pipeline assertions)`);
  lines.push("");
  lines.push(`| Verdict | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| ✓ PASS (full pipeline) | ${tests.pass} |`);
  lines.push(`| ✗ FAIL | ${tests.fail} |`);
  lines.push(`| ⊘ SKIP | ${tests.skip} |`);
  lines.push("");

  lines.push(`## Pipeline metrics`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Books indexed (crystallized) | ${indexed} |`);
  lines.push(`| Books evaluated only | ${evaluated} |`);
  lines.push(`| Books imported only | ${importedOnly} |`);
  lines.push(`| Books failed | ${failed} |`);
  lines.push(`| Books skipped | ${skipped} |`);
  lines.push(`| Concepts raw | ${totalRaw} |`);
  lines.push(`| Concepts after intra-dedup | ${totalDedup} |`);
  lines.push(`| Concepts accepted (in Qdrant) | ${totalAccepted} |`);
  lines.push(`| Concepts rejected | ${totalRejected} |`);
  lines.push(`| Errors total | ${totalErrors} |`);
  lines.push("");

  /* Iter 7: per-book test report -- 4 stages × N books grid. */
  const v = (s: StageVerdict | undefined): string => (s === "PASS" ? "✓" : s === "FAIL" ? "✗" : "⊘");
  lines.push(`## Per-book test results`);
  lines.push("");
  lines.push(`| Book | Parse | Eval | Cryst | Persist | Overall | Quality | Domain | Words | Concepts (raw→acc) | Duration |`);
  lines.push(`|---|:-:|:-:|:-:|:-:|:-:|:-:|---|---:|---|---:|`);
  for (const b of books) {
    const counts = `${b.rawConcepts ?? 0}→${b.acceptedConcepts ?? 0}`;
    const dur = b.durationMs ? `${(b.durationMs / 1000).toFixed(1)}s` : "—";
    const words = b.wordCount ? b.wordCount.toLocaleString("en-US") : "—";
    lines.push(
      `| ${md(b.bookName)} | ${v(b.stages?.parse)} | ${v(b.stages?.evaluate)} | ${v(b.stages?.crystallize)} | ${v(b.stages?.persist)} | **${v(b.stages?.overall)}** | ${b.qualityScore ?? "—"} | ${md(b.domain ?? "—")} | ${words} | ${counts} | ${dur} |`,
    );
  }
  lines.push("");
  lines.push(`Legend: ✓ PASS · ✗ FAIL · ⊘ SKIP`);
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

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`\n${COLOR.bold}=== Bibliary E2E Batch Library (Iter 7 -- full pipeline) ===${COLOR.reset}`);
  console.log(`LM Studio    : ${HTTP_URL}`);
  console.log(`Qdrant       : ${QDRANT_URL_ENV}`);
  console.log(`Downloads    : ${args.downloadsDir}`);
  console.log(`Library root : ${args.libraryRoot}`);
  console.log(`Target coll. : ${args.targetCollection}`);
  console.log(`Quality thr. : ${args.qualityThreshold}`);
  console.log(`Score thr.   : ${args.scoreThreshold}`);
  console.log(`Skip eval    : ${args.skipEvaluate}`);
  console.log(`Skip cryst.  : ${args.skipCrystallize}`);
  console.log(`Skip library : ${args.skipLibrary}`);
  console.log(`Max size     : ${args.maxSizeMb} MB`);
  console.log(`Max books    : ${args.maxBooks ?? "no limit"}`);
  console.log(`Max chap.    : ${args.maxChapters ?? "no limit"}`);
  console.log(`Restart      : ${args.restart}\n`);

  /* Iter 7: ранняя валидация коллекции -- assertValidCollectionName
     бросает понятный Error, если юзер передал невалидное имя. */
  try {
    assertValidCollectionName(args.targetCollection);
  } catch (e) {
    fatal(`invalid --target-collection: ${e instanceof Error ? e.message : e}`);
  }

  // ── Pre-flight ────────────────────────────────────────────────────────────
  console.log(`${COLOR.cyan}[pre-flight]${COLOR.reset} probing services...`);
  const lm = await probeLmStudio();
  /* Qdrant нужен только если будем кристаллизовать. */
  if (!args.skipCrystallize) await probeQdrant();
  await probeDownloads(args.downloadsDir);

  // Pick models (extractor + judge — same caskade as e2e-full-mvp)
  const TAG_PRIORITY: ModelTag[] = ["flagship", "tool-capable-coder", "non-thinking-instruct", "small-fast"];
  const HINTS = ["qwen3.6", "qwen3-coder", "mistral-small", "qwen3-14b", "qwen3-4b-2507"];
  const extractModel = await pickModelByTags(lm.models, TAG_PRIORITY, HINTS);
  const judgeModel = await pickModelByTags(lm.models, TAG_PRIORITY, HINTS);
  if (!extractModel || !judgeModel) fatal(`No suitable model picked (loaded: ${lm.models.join(", ")})`);

  /* Iter 7: evaluator-модель -- независимая, ищется через pickEvaluatorModel
     (предпочитает thinking-семейство). Юзер может override через
     --evaluator-model "qwen3.6-35b-a3b". */
  let evaluatorModel: string | null = args.evaluatorModel;
  if (!evaluatorModel && !args.skipEvaluate) {
    evaluatorModel = await pickEvaluatorModel();
  }
  if (!args.skipEvaluate && !evaluatorModel) {
    fatal(`Evaluator model not pickable; pass --evaluator-model or --skip-evaluate.`);
  }

  console.log(`${COLOR.cyan}[pre-flight]${COLOR.reset} extractor = ${extractModel}`);
  console.log(`${COLOR.cyan}[pre-flight]${COLOR.reset} judge     = ${judgeModel}`);
  console.log(`${COLOR.cyan}[pre-flight]${COLOR.reset} evaluator = ${evaluatorModel ?? "(skipped)"}`);

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
    /* Resume logic: skip books already reaching a terminal-ish state in prior run.
       `evaluated` counts as terminal when --skip-crystallize=true, because no
       further stage will run for it. Same for `imported` when --skip-evaluate. */
    const terminalStates: BookStatus[] = ["done", "failed", "duplicate", "indexed"];
    if (args.skipCrystallize) terminalStates.push("evaluated");
    if (args.skipEvaluate && args.skipCrystallize) terminalStates.push("imported");
    if (prev && terminalStates.includes(prev.status) && !args.restart) {
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
      result = await processBook(book, args, extractModel, judgeModel, evaluatorModel, abortCtl.signal, null);
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

    /* Iter 7: library import + SQLite persist теперь ВНУТРИ processBook.
       Этот блок упразднён -- никаких побочных вызовов после returns. */

    // Re-render aggregates after each book (so user can peek mid-run)
    await writeIndex(outDir, state);
    await writeErrors(outDir, state);
    await writeByDomain(outDir, state, allAccepted);
    await saveState(stateFile, state);

    /* Iter 7: per-book test-style report (4 stages = 4 assertions). */
    const dur = ((result.bookState.durationMs ?? 0) / 1000).toFixed(1);
    const bookStages = result.bookState.stages;
    const verdictColor =
      bookStages?.overall === "PASS" ? COLOR.green
      : bookStages?.overall === "FAIL" ? COLOR.red
      : COLOR.yellow;
    const stageGlyph = (v: StageVerdict | undefined): string =>
      v === "PASS" ? `${COLOR.green}✓${COLOR.reset}`
      : v === "FAIL" ? `${COLOR.red}✗${COLOR.reset}`
      : `${COLOR.dim}⊘${COLOR.reset}`;
    const ev = result.bookState;
    console.log(
      `  ${stageGlyph(bookStages?.parse)} PARSE        chapters=${ev.totalChapters ?? 0} words=${(ev.wordCount ?? 0).toLocaleString("en-US")}${ev.bookId ? ` id=${ev.bookId.slice(0, 8)}` : ""}`,
    );
    if (bookStages?.evaluate !== "SKIP") {
      console.log(
        `  ${stageGlyph(bookStages?.evaluate)} EVALUATE     quality=${ev.qualityScore ?? "?"} domain="${ev.domain ?? "?"}" fiction=${ev.isFictionOrWater ?? "?"}${ev.evaluatorReasoningChars ? ` reasoning=${ev.evaluatorReasoningChars}c` : ""}`,
      );
    }
    if (bookStages?.crystallize !== "SKIP") {
      console.log(
        `  ${stageGlyph(bookStages?.crystallize)} CRYSTALLIZE  ch=${ev.processedChapters ?? 0}/${ev.totalChapters ?? 0} raw=${ev.rawConcepts ?? 0} dedup=${ev.dedupedConcepts ?? 0} accepted=${ev.acceptedConcepts ?? 0} → ${args.targetCollection}`,
      );
    } else if (ev.crystallizeSkippedReason) {
      console.log(`  ${COLOR.dim}⊘ CRYSTALLIZE  skipped: ${ev.crystallizeSkippedReason}${COLOR.reset}`);
    }
    console.log(
      `  ${stageGlyph(bookStages?.persist)} PERSIST      sqlite=${args.skipLibrary ? "(skipped)" : "ok"} status=${ev.status}`,
    );
    console.log(
      `  ${verdictColor}${COLOR.bold}${bookStages?.overall ?? "?"}${COLOR.reset} in ${dur}s ${ev.errors && ev.errors.length > 0 ? `(${ev.errors.length} errors)` : ""}`,
    );
    processed++;
  }

  state.finishedAt = new Date().toISOString();
  await writeIndex(outDir, state);
  await writeErrors(outDir, state);
  await writeByDomain(outDir, state, allAccepted);
  await saveState(stateFile, state);

  /* Iter 7: финальный test-summary (как jest-suite footer). */
  const allBooks = Object.values(state.books);
  const tests = {
    pass: allBooks.filter((b) => b.stages?.overall === "PASS").length,
    fail: allBooks.filter((b) => b.stages?.overall === "FAIL").length,
    skip: allBooks.filter((b) => !b.stages || b.stages.overall === "SKIP").length,
  };
  const stageStats = {
    parse: { pass: 0, fail: 0, skip: 0 },
    evaluate: { pass: 0, fail: 0, skip: 0 },
    crystallize: { pass: 0, fail: 0, skip: 0 },
    persist: { pass: 0, fail: 0, skip: 0 },
  };
  for (const b of allBooks) {
    if (!b.stages) continue;
    for (const k of ["parse", "evaluate", "crystallize", "persist"] as const) {
      const v = b.stages[k];
      if (v === "PASS") stageStats[k].pass++;
      else if (v === "FAIL") stageStats[k].fail++;
      else stageStats[k].skip++;
    }
  }

  console.log(`\n${COLOR.bold}=== TEST SUMMARY ===${COLOR.reset}`);
  console.log(`Books: ${allBooks.length}  ${COLOR.green}✓ ${tests.pass} pass${COLOR.reset}  ${COLOR.red}✗ ${tests.fail} fail${COLOR.reset}  ${COLOR.dim}⊘ ${tests.skip} skip${COLOR.reset}`);
  for (const [stage, s] of Object.entries(stageStats)) {
    const total = s.pass + s.fail + s.skip;
    console.log(`  ${stage.padEnd(12)} ${COLOR.green}✓ ${s.pass}${COLOR.reset}  ${COLOR.red}✗ ${s.fail}${COLOR.reset}  ${COLOR.dim}⊘ ${s.skip}${COLOR.reset}  / ${total}`);
  }
  console.log(`\nProcessed this session : ${processed} / ${books.length}`);
  console.log(`Total accepted concepts: ${allAccepted.length}`);
  console.log(`Target collection      : ${args.targetCollection}`);
  console.log(`Report                 : ${path.relative(process.cwd(), outDir)}`);
  console.log(`  - index.md     (per-book summary)`);
  console.log(`  - by-domain.md (thematic breakdown)`);
  console.log(`  - errors.md    (pipeline errors)`);
  console.log(`  - chunks/      (sample chunks JSON)`);
  console.log(`  - concepts/    (accepted concepts JSON)`);
  console.log(`  - raw-events.jsonl (full event stream)\n`);

  if (interrupted) process.exit(1);
  /* Iter 7: exit code = number of failed tests (0 = всё зелёное). */
  process.exit(tests.fail);
}

/* SAFETY NET: pdfjs-dist (legacy build) выбрасывает XRefEntryException и
   подобные ошибки из ВНУТРЕННИХ async-callback'ов worker'а — даже после
   того как наш `await page.getTextContent()` уже вернул управление.
   Эти rejected-промисы ускользают мимо try/catch вокруг parseBook и в
   Node 22 по умолчанию роняют ВЕСЬ batch-процесс (ERR_UNHANDLED_REJECTION).
   Логируем и продолжаем — конкретная книга всё равно будет помечена как
   failed по результату await parseBook(). */
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  console.error(`\n[unhandled-rejection swallowed] ${msg.slice(0, 240)}\n`);
});

process.on("uncaughtException", (err) => {
  console.error(`\n[uncaught-exception swallowed] ${err.name}: ${err.message.slice(0, 240)}\n`);
});

main().catch((e) => {
  console.error(`\n${COLOR.red}${COLOR.bold}UNHANDLED:${COLOR.reset} ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
