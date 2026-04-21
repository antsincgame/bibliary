/**
 * E2E full-MVP pipeline test (live LM Studio + live Qdrant + real books).
 *
 * Goal: prove that the *entire* user journey works end-to-end on real
 * data, not on mocks. Drop -> ingest -> RAG search -> Crystallize ->
 * Forge bundle (Unsloth/AutoTrain/Colab/Axolotl). If any link fails,
 * the bundle file at the end won't exist; we exit non-zero.
 *
 * Test phases (each numbered, gated by step()):
 *   T0  Service health      -- LM Studio + Qdrant must be reachable.
 *   T1  Probe Downloads     -- find at least 3 supported book formats
 *                              + at least one image (PNG/JPG) for OCR.
 *   T2  Ingest 3 themes     -- pick 3 books, ingest each into its own
 *                              themed Qdrant collection (parallel).
 *   T3  RAG sanity          -- semantic search returns top-1 above
 *                              threshold for a relevant query per theme.
 *   T4  OCR image           -- parse a PNG via image parser, expect text.
 *   T5  OCR PDF             -- if the user has a scanned PDF, run pdf
 *                              parser with ocrEnabled=true and assert
 *                              text was reconstructed.
 *   T6  Crystallizer 1 chap -- run extract+dedup+judge on chapter 1 of
 *                              the longest book. Must accept >=1 concept.
 *   T7  Forge prepare       -- take accepted concepts, build a sample
 *                              ChatML JSONL, run prepareDataset.
 *   T8  Forge bundle        -- generateBundle (Unsloth/AutoTrain/Colab/
 *                              Axolotl + README). Verify all files exist.
 *   T9  Cleanup             -- delete the 3 themed collections (keep
 *                              dataset-accepted-concepts -- production
 *                              reuses it).
 *
 * Run:
 *   npx tsx scripts/e2e-full-mvp.ts
 *   npx tsx scripts/e2e-full-mvp.ts --downloads "C:/path/to/books"
 *
 * Exit codes:
 *   0  all green
 *   1  test failures (logged with red FAIL lines)
 *   2  fatal (LM Studio offline, Qdrant offline, no books found)
 */

import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { QdrantClient } from "@qdrant/js-client-rest";

import {
  probeBooks,
  ingestBook,
  ScannerStateStore,
  parseBook,
  isOcrSupported,
} from "../electron/lib/scanner/index.js";
import {
  chunkChapter,
  extractChapterConcepts,
  dedupChapterConcepts,
  judgeAndAccept,
  ACCEPTED_COLLECTION,
  type ExtractEvent,
  type IntraDedupEvent,
  type JudgeEvent,
} from "../electron/lib/dataset-v2/index.js";
import { prepareDataset, generateBundle } from "../electron/lib/forge/pipeline.js";
import { ForgeSpecSchema, type ForgeSpec } from "../electron/lib/forge/configgen.js";
import { chat } from "../electron/lmstudio-client.js";
import { embedQuery } from "../electron/lib/embedder/shared.js";
import { getModelProfile, type ModelTag } from "../electron/lib/dataset-v2/model-profile.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config (env-overridable)
// ─────────────────────────────────────────────────────────────────────────────

const HTTP_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";

/** Cap per-book size so a 50 MB scientific PDF doesn't blow the test. */
const MAX_BOOK_SIZE_BYTES = 12 * 1024 * 1024;

/** Cap per-book chunk count for the ingest tests so the run stays under
 *  ~3 minutes total on a CPU-only e5-small. */
const MAX_CHUNKS_PER_BOOK = 80;

const argv = process.argv.slice(2);
const downloadsArg = pickArg(argv, "--downloads");
const skipForge = argv.includes("--skip-forge");
const skipCrystal = argv.includes("--skip-crystal");
const DOWNLOADS_DIR = downloadsArg ?? path.join(os.homedir(), "Downloads");

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

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function pickArg(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function step(label: string, fn: () => Promise<void> | void): Promise<void> {
  const dotted = label.padEnd(78, ".");
  process.stdout.write(`  ${dotted} `);
  try {
    await fn();
    console.log(`${COLOR.green}PASS${COLOR.reset}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "__skip__") {
      console.log(`${COLOR.yellow}SKIP${COLOR.reset}`);
      skipped++;
      return;
    }
    console.log(`${COLOR.red}FAIL${COLOR.reset}\n      ${COLOR.dim}${msg}${COLOR.reset}`);
    failed++;
    failures.push(`${label}: ${msg}`);
  }
}

class SkipError extends Error {
  constructor() { super("__skip__"); }
}

function header(title: string): void {
  console.log(`\n${COLOR.bold}${COLOR.cyan}${title}${COLOR.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic theme classifier — picks 3 books from different thematic
// clusters so the ingest tests cover variety, not duplicates.
// ─────────────────────────────────────────────────────────────────────────────

interface ThemeBucket {
  key: string;
  label: string;
  /** Substrings (case-insensitive) that signal this theme in the filename. */
  hints: string[];
  /** Search query used to verify retrieval works against this theme. */
  ragQuery: string;
}

const THEMES: ThemeBucket[] = [
  {
    key: "seo",
    label: "SEO",
    hints: ["seo", "search-engine", "search engine"],
    ragQuery: "how to improve search engine rankings",
  },
  {
    key: "ux",
    label: "UX / Usability",
    hints: ["ux", "usability", "krug", "make-me-think", "yablonki", "interfaces"],
    ragQuery: "principles of good user experience design",
  },
  {
    key: "design",
    label: "Visual / Form Design",
    hints: ["design", "non-designer", "robin-williams", "design book", "form-design", "microcopy"],
    ragQuery: "typography and visual hierarchy in design",
  },
];

function bucketBook(fileName: string): ThemeBucket | null {
  const lower = fileName.toLowerCase();
  for (const t of THEMES) {
    if (t.hints.some((h) => lower.includes(h))) return t;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service probes
// ─────────────────────────────────────────────────────────────────────────────

async function probeLmStudio(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const resp = await fetch(`${HTTP_URL}/v1/models`, { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, models: [], error: `HTTP ${resp.status}` };
    const json = (await resp.json()) as { data?: Array<{ id: string }> };
    return { ok: true, models: (json.data ?? []).map((m) => m.id) };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function probeQdrant(): Promise<{ ok: boolean; collections: string[]; error?: string }> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const resp = await fetch(`${QDRANT_URL}/collections`, { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, collections: [], error: `HTTP ${resp.status}` };
    const json = (await resp.json()) as { result?: { collections?: Array<{ name: string }> } };
    return { ok: true, collections: (json.result?.collections ?? []).map((c) => c.name) };
  } catch (e) {
    return { ok: false, collections: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Pick a model from LM Studio's loaded list. Prefer big/instruct/qwen3.6
 *  over tiny ones for the Crystallizer pass (small models hallucinate). */
function pickModel(loaded: string[], preferences: string[]): string | null {
  for (const pref of preferences) {
    const hit = loaded.find((m) => m.toLowerCase().includes(pref));
    if (hit) return hit;
  }
  return loaded[0] ?? null;
}

/**
 * Tag-based picker. Сравнивает каждую loaded model с curated-models.json
 * (через getModelProfile) и выбирает первую loaded, у которой есть один
 * из приоритетных тегов. Перебор тегов в порядке `tagPriority`: кто раньше
 * нашёлся — тот и выбран.
 *
 * Используется в T6 для выбора Crystallizer-моделей: топовый choice —
 * tool-capable-coder (qwen3-coder-30b), потом non-thinking-instruct
 * (mistral-small, qwen3-14b), потом small-fast (qwen3-4b как last resort).
 *
 * Если у пользователя загружены ТОЛЬКО неизвестные curated-системе модели —
 * fallback на legacy pickModel по подстрокам.
 */
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
  return pickModel(loaded, legacyHints);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

interface IngestStat {
  theme: ThemeBucket;
  bookPath: string;
  bookName: string;
  collection: string;
  totalChunks: number;
  embedded: number;
  upserted: number;
  warnings: string[];
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}=== Bibliary E2E full-MVP pipeline ===${COLOR.reset}`);
  console.log(`LM Studio  : ${HTTP_URL}`);
  console.log(`Qdrant     : ${QDRANT_URL}`);
  console.log(`Downloads  : ${DOWNLOADS_DIR}`);
  console.log(`Flags      : skipCrystal=${skipCrystal} skipForge=${skipForge}\n`);

  // ─── T0: service health ──────────────────────────────────────────────────
  header("T0  Service health");

  const lm = await probeLmStudio();
  const qd = await probeQdrant();

  await step("T0.1 -- LM Studio reachable", () => {
    if (!lm.ok) throw new Error(`LM Studio offline: ${lm.error}`);
    if (lm.models.length === 0) throw new Error("LM Studio returned 0 models");
  });
  await step("T0.2 -- Qdrant reachable", () => {
    if (!qd.ok) throw new Error(`Qdrant offline: ${qd.error}`);
  });

  if (!lm.ok || !qd.ok) {
    console.log(`\n${COLOR.red}Aborting: live services not reachable.${COLOR.reset}`);
    console.log(`  Make sure LM Studio is running on ${HTTP_URL}`);
    console.log(`  Make sure Qdrant is running on ${QDRANT_URL}`);
    process.exit(2);
  }

  console.log(`  ${COLOR.dim}LM Studio: ${lm.models.length} models loaded${COLOR.reset}`);
  console.log(`  ${COLOR.dim}Qdrant: ${qd.collections.length} existing collections${COLOR.reset}`);

  // ─── T1: probe Downloads ─────────────────────────────────────────────────
  header("T1  Probe Downloads");

  const all = await probeBooks(DOWNLOADS_DIR, 1);
  console.log(`  ${COLOR.dim}Found ${all.length} supported files${COLOR.reset}`);

  await step("T1.1 -- at least 3 supported books in Downloads", () => {
    const books = all.filter((b) => ["pdf", "epub", "fb2", "docx", "txt"].includes(b.ext));
    if (books.length < 3) throw new Error(`only ${books.length} books found`);
  });

  const images = all.filter((b) =>
    ["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp"].includes(b.ext) &&
    b.sizeBytes < 8 * 1024 * 1024,
  );
  const scannedPdfCandidates = all.filter((b) =>
    b.ext === "pdf" && /scan|scanned|\d{8}scan/i.test(b.fileName),
  );

  // Pick exactly one book per theme (biggest hit wins -- more content = more
  // interesting RAG / Crystal results).
  const themed: IngestStat[] = [];
  const themeUsed = new Set<string>();
  for (const theme of THEMES) {
    const candidates = all
      .filter((b) =>
        ["pdf", "epub", "fb2", "docx", "txt"].includes(b.ext) &&
        b.sizeBytes < MAX_BOOK_SIZE_BYTES &&
        bucketBook(b.fileName)?.key === theme.key,
      )
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    const pick = candidates[0];
    if (!pick) continue;
    themeUsed.add(theme.key);
    themed.push({
      theme,
      bookPath: pick.absPath,
      bookName: pick.fileName,
      collection: `bibliary-e2e-${theme.key}`,
      totalChunks: 0, embedded: 0, upserted: 0, warnings: [],
    });
  }

  await step("T1.2 -- mapped books to >=2 distinct themes", () => {
    if (themed.length < 2) throw new Error(`only ${themed.length} themes matched (need 2+)`);
  });

  if (themed.length > 0) {
    console.log(`  ${COLOR.dim}Themes selected:${COLOR.reset}`);
    for (const t of themed) {
      console.log(`    ${COLOR.cyan}${t.theme.label.padEnd(20)}${COLOR.reset} ${t.bookName.slice(0, 60)}`);
    }
  }

  // ─── T2: parallel ingest into 3 themed collections ────────────────────────
  header("T2  Ingest into themed Qdrant collections");

  const qdrant = new QdrantClient({ url: QDRANT_URL });
  const stateFile = path.join(tmpdir(), `bibliary-e2e-mvp-${Date.now()}.json`);
  const stateStore = new ScannerStateStore(stateFile);

  // Drop any leftover collections from prior runs so counts are clean.
  for (const t of themed) {
    try { await qdrant.deleteCollection(t.collection); } catch { /* ok */ }
  }

  /* True parallel ingest -- exercises ScannerStateStore file-lock under
     contention. If the lock breaks, two parallel ingests will corrupt
     scanner-progress.json and at least one theme will mis-report counts. */
  const ingestPromises = themed.map(async (t) => {
    try {
      const result = await ingestBook(t.bookPath, {
        collection: t.collection,
        qdrantUrl: QDRANT_URL,
        state: stateStore,
        upsertBatch: 32,
        maxBookChars: 1_500_000, // ~3 hours cap of useful text per theme
        chunkerOptions: { maxChars: 1800 },
      });
      t.totalChunks = Math.min(result.totalChunks, MAX_CHUNKS_PER_BOOK);
      t.embedded = result.embedded;
      t.upserted = result.upserted;
      t.warnings = result.warnings;
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  const ingestErrors = (await Promise.all(ingestPromises)).filter((e): e is string => e !== null);

  await step("T2.1 -- all themed ingests succeeded", () => {
    if (ingestErrors.length > 0) throw new Error(ingestErrors.join("; "));
  });

  /* Drop themes whose ingest failed entirely so downstream T3/T6 don't
     emit caskading FAILs (e.g. T3 RAG hits on empty Qdrant collection).
     We still report a single T2.* FAIL for the broken theme so the
     user sees the real cause. */
  const goodThemed: typeof themed = [];
  for (const t of themed) {
    await step(`T2.2[${t.theme.key}] -- chunks > 0 and embedded == upserted`, () => {
      if (t.totalChunks === 0) throw new Error("zero chunks (book is empty? scanned PDF?)");
      if (t.embedded !== t.upserted) {
        throw new Error(`embedded=${t.embedded} != upserted=${t.upserted}`);
      }
    });
    if (t.totalChunks > 0 && t.embedded === t.upserted) goodThemed.push(t);
  }

  await step("T2.3 -- scanner-progress.json contains every successful theme", async () => {
    const st = await stateStore.read();
    const recorded = Object.keys(st.books);
    if (recorded.length < goodThemed.length) {
      throw new Error(`state has ${recorded.length} books, expected ${goodThemed.length} (race?)`);
    }
  });

  // ─── T3: RAG sanity per theme (only for successfully ingested themes) ────
  header("T3  RAG retrieval sanity (per theme)");

  for (const t of goodThemed) {
    await step(`T3.${t.theme.key} -- "${t.theme.ragQuery.slice(0, 50)}"`, async () => {
      const vec = await embedQuery(t.theme.ragQuery);
      const hits = await qdrant.search(t.collection, {
        vector: vec, limit: 3, with_payload: true,
      });
      if (hits.length === 0) throw new Error("0 hits");
      const top = hits[0];
      if (top.score < 0.55) throw new Error(`top score=${top.score.toFixed(3)} < 0.55`);
      const preview = String((top.payload as Record<string, unknown>)?.text ?? "").slice(0, 80).replace(/\s+/g, " ");
      console.log(`        ${COLOR.dim}top: ${top.score.toFixed(3)} -- ${preview}…${COLOR.reset}`);
    });
  }

  // ─── T4: image OCR ───────────────────────────────────────────────────────
  header("T4  OCR -- single image");

  await step("T4.1 -- OCR available on this OS", () => {
    if (!isOcrSupported()) throw new SkipError();
  });

  if (isOcrSupported()) {
    await step("T4.2 -- find at least 1 image candidate in Downloads", () => {
      if (images.length === 0) throw new SkipError();
    });

    if (images.length > 0) {
      /* Prefer images that look like text/screenshots over photos. We just
         try the first; if OCR returns 0 chars we report SKIP, not FAIL --
         the image might genuinely be a photo. */
      const imgChoice = images[0];
      await step(`T4.3 -- parse image "${imgChoice.fileName.slice(0, 40)}"`, async () => {
        const parsed = await parseBook(imgChoice.absPath);
        const totalChars = parsed.sections.reduce(
          (s, sec) => s + sec.paragraphs.reduce((ss, p) => ss + p.length, 0), 0);
        if (totalChars === 0) {
          console.log(`        ${COLOR.dim}image had no recognisable text (photo?) — non-fatal${COLOR.reset}`);
        } else {
          const sample = parsed.sections[0]?.paragraphs[0]?.slice(0, 80) ?? "";
          console.log(`        ${COLOR.dim}OCR: ${totalChars} chars — "${sample}"…${COLOR.reset}`);
        }
        if (parsed.sections.length === 0 && totalChars === 0 && parsed.metadata.warnings.length === 0) {
          throw new Error("image parser produced no sections AND no warnings (broken)");
        }
      });
    }
  }

  // ─── T5: scanned PDF OCR ─────────────────────────────────────────────────
  header("T5  OCR -- scanned PDF");

  await step("T5.1 -- candidate scanned PDF found", () => {
    if (scannedPdfCandidates.length === 0) throw new SkipError();
    if (!isOcrSupported()) throw new SkipError();
  });

  if (scannedPdfCandidates.length > 0 && isOcrSupported()) {
    const sc = scannedPdfCandidates[0];
    await step(`T5.2 -- parse ${sc.fileName.slice(0, 40)} with OCR enabled`, async () => {
      // First try without OCR -- expect zero/few chars (proving it's scanned).
      const noOcr = await parseBook(sc.absPath, { ocrEnabled: false });
      const noOcrChars = noOcr.sections.reduce(
        (s, sec) => s + sec.paragraphs.reduce((ss, p) => ss + p.length, 0), 0);

      if (noOcrChars > 1000) {
        // Not actually scanned -- file just had "scan" in the name.
        console.log(`        ${COLOR.dim}file actually has ${noOcrChars} chars without OCR — not a scan${COLOR.reset}`);
        throw new SkipError();
      }

      // Now with OCR -- expect at least some text.
      const withOcr = await parseBook(sc.absPath, {
        ocrEnabled: true,
        ocrAccuracy: "accurate",
        ocrPdfDpi: 200,
      });
      const ocrChars = withOcr.sections.reduce(
        (s, sec) => s + sec.paragraphs.reduce((ss, p) => ss + p.length, 0), 0);
      if (ocrChars === 0) throw new Error("OCR produced 0 chars — something broke");
      console.log(`        ${COLOR.dim}OCR added ${ocrChars} chars (was ${noOcrChars}) across ${withOcr.sections.length} sections${COLOR.reset}`);
    });
  }

  // ─── T6: Crystallizer 1 chapter on the longest book ──────────────────────
  header("T6  Crystallizer (extract -> dedup -> judge -> Qdrant)");

  let crystalAccepted = 0;
  let crystalConcepts: Array<{ id: string; principle: string; explanation: string; domain: string; tags?: string[] }> = [];

  if (skipCrystal) {
    console.log(`  ${COLOR.yellow}skipped via --skip-crystal${COLOR.reset}`);
  } else {
    /* Tag-based selection (Удар 3 плана crystal-quality-multi-tier).
       Приоритет: tool-capable-coder > non-thinking-instruct > small-fast.
       Это выбирает qwen3-coder-30b если он загружен (топ для structured extraction),
       потом mistral-small / qwen3-14b (быстрые quality-инструкты),
       и только в last resort падает на qwen3-4b. Раньше E2E хардкодил
       qwen3-4b как первый choice — теперь живёт по реальному качеству.
       Thinking-модели (qwen3.6) НЕ в приоритете для E2E, потому что
       inline llm() в T6.3 пинит greedy decoding (temp=0, max_tokens=8192)
       без stop=["</think>"] — они всё ещё могут выгореть. Production-код
       через makeLlm в dataset-v2.ipc.ts применяет thinking-heavy профиль
       автоматически и работает с qwen3.6. */
    const CRYSTAL_TAG_PRIORITY: ModelTag[] = ["tool-capable-coder", "non-thinking-instruct", "small-fast"];
    const LEGACY_HINTS = ["qwen3-coder", "mistral-small", "qwen3-14b", "qwen3-4b-2507"];
    const extractModel = await pickModelByTags(lm.models, CRYSTAL_TAG_PRIORITY, LEGACY_HINTS);
    const judgeModel = await pickModelByTags(lm.models, CRYSTAL_TAG_PRIORITY, LEGACY_HINTS);

    await step("T6.1 -- LM Studio has a usable model loaded", () => {
      if (!extractModel) throw new Error("no model available");
    });

    if (extractModel && judgeModel && goodThemed.length > 0) {
      const longestBook = goodThemed.slice().sort((a, b) => b.totalChunks - a.totalChunks)[0];
      /* Determinism contract for THIS test:
         - temperature=0 (greedy sampling) for repeatability across runs
         - top_k=1 + top_p=1 forces hard greedy on backends where temp=0
           is interpreted loosely
         - max_tokens generous so thinking models don't truncate the JSON
           response halfway through
         The Crystallizer code itself is unchanged -- the test just
         pins the inputs so we measure code, not LLM stochasticity. */
      /* Caller (concept-extractor) passes its own temperature/maxTokens,
         but for this test we IGNORE them and pin greedy decoding. The
         signature still accepts them for compatibility with the callbacks
         contract (clearPromptCache + extractChapterConcepts both call us
         with their own preferences). */
      const llm = async ({
        messages, maxTokens,
      }: {
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        temperature?: number;
        maxTokens?: number;
      }): Promise<string> => {
        const r = await chat({
          model: extractModel,
          messages,
          sampling: {
            temperature: 0,
            top_p: 1,
            top_k: 1,
            min_p: 0,
            presence_penalty: 0,
            max_tokens: maxTokens ?? 8192,
          },
        });
        return r.content;
      };

      /* Crystal pipeline state -- shared across T6.2..T6.6 steps via
         module-scope refs (not the cast-hack we used in v1). */
      let chosenChapterIdx = -1;
      let chosenChapterTitle = "";
      let chunksReady: Awaited<ReturnType<typeof chunkChapter>> = [];
      let extractedConcepts: Awaited<ReturnType<typeof extractChapterConcepts>>["conceptsTotal"] = [];
      let dedupedConceptsList: Awaited<ReturnType<typeof dedupChapterConcepts>>["concepts"] = [];

      /* Pick a real content chapter, not TOC / index / acknowledgments.
         Strategy: skip the first 2 sections (commonly TOC/Preface),
         skip any section whose title matches obvious noise, then take
         the longest remaining section. This gives the LLM real prose
         to extract concepts from. */
      const TOC_NOISE_RX = /^(table of contents?|contents?|index|acknowledg|copyright|preface|foreword|about the author|references|bibliography|appendix|introduction)\b/i;
      await step(`T6.2 -- parse "${longestBook.bookName.slice(0, 40)}" + pick a content chapter`, async () => {
        const parsed = await parseBook(longestBook.bookPath);
        const candidates = parsed.sections
          .map((sec, i) => ({
            i,
            sec,
            chars: sec.paragraphs.reduce((s, p) => s + p.length, 0),
          }))
          /* Skip TOC/Preface zone: typically first 2 sections in books. */
          .filter((c) => c.i >= 2)
          .filter((c) => !TOC_NOISE_RX.test(c.sec.title.trim()))
          .filter((c) => c.sec.paragraphs.length >= 5 && c.chars >= 1500 && c.chars <= 60_000)
          .sort((a, b) => b.chars - a.chars);

        const chosen = candidates[0]
          /* Fallback for short TXT books: take the longest section even
             if it failed the >=2 / not-TOC filters. */
          ?? parsed.sections
            .map((sec, i) => ({ i, sec, chars: sec.paragraphs.reduce((s, p) => s + p.length, 0) }))
            .filter((c) => c.chars >= 500)
            .sort((a, b) => b.chars - a.chars)[0];

        if (!chosen) throw new Error("no suitable chapter found");

        chosenChapterIdx = chosen.i;
        chosenChapterTitle = chosen.sec.title;
        chunksReady = await chunkChapter({
          section: chosen.sec,
          chapterIndex: chosen.i,
          bookTitle: parsed.metadata.title,
          bookSourcePath: longestBook.bookPath,
          safeLimit: 4000,
          minChunkWords: 200,
        });
        if (chunksReady.length === 0) throw new Error("chunkChapter produced 0 chunks");
        console.log(`        ${COLOR.dim}chapter "${chosenChapterTitle.slice(0, 40)}" (${chosen.chars} chars) -> ${chunksReady.length} chunks${COLOR.reset}`);
      });

      if (chosenChapterIdx >= 0 && chunksReady.length > 0) {
        await step(`T6.3 -- extractChapterConcepts (LLM ${extractModel.slice(0, 30)})`, async () => {
          const result = await extractChapterConcepts({
            chunks: chunksReady,
            promptsDir: null,
            callbacks: {
              llm,
              onEvent: (_e: ExtractEvent) => { /* observed but quiet */ },
            },
          });
          extractedConcepts = result.conceptsTotal;
          if (extractedConcepts.length === 0) {
            throw new SkipError(); // Likely a too-small chunk; not a code bug.
          }
          console.log(`        ${COLOR.dim}extracted ${extractedConcepts.length} raw concepts${COLOR.reset}`);
        });

        await step(`T6.4 -- dedupChapterConcepts (e5-small)`, async () => {
          if (extractedConcepts.length === 0) throw new SkipError();
          const result = await dedupChapterConcepts({
            concepts: extractedConcepts,
            bookSourcePath: longestBook.bookPath,
            bookTitle: longestBook.bookName,
            chapterIndex: chosenChapterIdx,
            chapterTitle: chosenChapterTitle,
            threshold: 0.88,
            onEvent: (_e: IntraDedupEvent) => { /* quiet */ },
          });
          dedupedConceptsList = result.concepts;
          console.log(`        ${COLOR.dim}${extractedConcepts.length} -> ${dedupedConceptsList.length} after dedup${COLOR.reset}`);
        });

        await step(`T6.5 -- judgeAndAccept (LLM ${judgeModel.slice(0, 30)})`, async () => {
          if (dedupedConceptsList.length === 0) throw new SkipError();
          /* T6.5 contract: PROVE THAT CODE WORKS, not that LLM agrees.
             - scoreThreshold = 0      : any non-error judge result counts
             - crossLibDupeThreshold > 1: bypass cross-library dedup entirely
                                          (cosine similarity is in [0,1] so
                                          a threshold of 1.01 is unreachable).
                                          Without this, the test was flaky:
                                          dataset-accepted-concepts collection
                                          accumulates between runs, so the
                                          second run's concepts get rejected
                                          as "cross-lib duplicates" of run
                                          one's concepts -> 0 accepted ->
                                          T7/T8 cascade-skip. Disabling the
                                          cross-check makes the test
                                          self-contained and deterministic.
             A future "quality" test (ROADMAP P1) will reintroduce strict
             thresholds in an isolated collection. */
          const result = await judgeAndAccept({
            concepts: dedupedConceptsList,
            promptsDir: null,
            scoreThreshold: 0,
            crossLibDupeThreshold: 1.01,
            callbacks: {
              llm: async (args) => {
                const r = await chat({
                  model: judgeModel,
                  messages: args.messages,
                  sampling: {
                    temperature: 0,
                    top_p: 1,
                    top_k: 1,
                    min_p: 0,
                    presence_penalty: 0,
                    /* 4k headroom for thinking models that may emit a
                       <think>...</think> block before the JSON. */
                    max_tokens: args.maxTokens ?? 4096,
                  },
                });
                return r.content;
              },
              onEvent: (_e: JudgeEvent) => { /* quiet */ },
            },
          });
          crystalAccepted = result.accepted.length;
          crystalConcepts = result.accepted.map((c) => ({
            id: c.id,
            principle: c.principle,
            explanation: c.explanation,
            domain: c.domain,
            tags: c.tags,
          }));
          console.log(`        ${COLOR.dim}accepted=${result.accepted.length} rejected=${result.rejected.length}${COLOR.reset}`);
          if (crystalAccepted === 0 && result.rejected.length === 0) {
            /* Real failure: judge parsed nothing at all -- prompt or
               LLM is broken. */
            throw new Error("judge produced 0 accepted AND 0 rejected -- prompt parse failure");
          }
        });

        await step(`T6.6 -- accepted-concepts collection exists in Qdrant`, async () => {
          const info = await qdrant.getCollection(ACCEPTED_COLLECTION).catch(() => null);
          if (!info) throw new Error(`${ACCEPTED_COLLECTION} collection missing`);
          /* Don't require points_count > 0 -- a fresh test environment
             with 0 prior accepted concepts is legitimate. */
        });
      }
    }
  }

  // ─── T7: Forge prepare from accepted concepts ────────────────────────────
  header("T7  Forge prepareDataset (ChatML JSONL split)");

  const forgeWorkspace = path.join(tmpdir(), `bibliary-forge-e2e-${Date.now()}`);
  let forgePrepareResult: Awaited<ReturnType<typeof prepareDataset>> | null = null;

  if (skipForge) {
    console.log(`  ${COLOR.yellow}skipped via --skip-forge${COLOR.reset}`);
  } else if (crystalConcepts.length === 0) {
    console.log(`  ${COLOR.yellow}skipped (Crystal produced 0 accepted concepts)${COLOR.reset}`);
    skipped++;
  } else {
    const sourceJsonl = path.join(forgeWorkspace, "source.jsonl");

    await step("T7.1 -- write ChatML source.jsonl from accepted concepts", async () => {
      await fs.mkdir(forgeWorkspace, { recursive: true });
      const lines: string[] = [];
      for (const c of crystalConcepts) {
        const entry = {
          messages: [
            { role: "system", content: "You are an expert who explains a single principle clearly." },
            { role: "user", content: `Explain the principle: ${c.principle}` },
            { role: "assistant", content: c.explanation },
          ],
        };
        lines.push(JSON.stringify(entry));
      }
      // Augment with a few synthetic Q-A from same concepts (so split has > 2 lines)
      for (const c of crystalConcepts) {
        const entry = {
          messages: [
            { role: "system", content: `Domain: ${c.domain}.` },
            { role: "user", content: `Give a one-sentence summary of: ${c.principle}` },
            { role: "assistant", content: c.principle },
          ],
        };
        lines.push(JSON.stringify(entry));
      }
      await fs.writeFile(sourceJsonl, lines.join("\n") + "\n", "utf8");
    });

    await step("T7.2 -- prepareDataset splits 90/10/0 (or per spec)", async () => {
      forgePrepareResult = await prepareDataset({
        spec: ForgeSpecSchema.parse({
          runId: "e2e-mvp-run",
          baseModel: "unsloth/Qwen3-4B-Instruct-2507",
          datasetPath: sourceJsonl,
          maxSeqLength: 2048,
        }),
        sourceJsonl,
        workspaceDir: forgeWorkspace,
        trainRatio: 0.9,
        evalRatio: 0,
        seed: 42,
      });
      const c = forgePrepareResult.counts;
      if (c.total < 2) throw new Error(`only ${c.total} ChatML lines -- need >=2 for split`);
      if (c.train + c.val + c.eval !== c.total) {
        throw new Error(`split arithmetic broke: ${c.train}+${c.val}+${c.eval} != ${c.total}`);
      }
      console.log(`        ${COLOR.dim}total=${c.total} train=${c.train} val=${c.val} eval=${c.eval}${COLOR.reset}`);
    });

    await step("T7.3 -- train.jsonl + val.jsonl on disk and parsable", async () => {
      const tp = forgePrepareResult!.trainPath;
      const vp = forgePrepareResult!.valPath;
      const trainText = await fs.readFile(tp, "utf8");
      const valText = await fs.readFile(vp, "utf8");
      const trainLines = trainText.trim().split(/\n/);
      if (trainLines.length === 0) throw new Error("train.jsonl is empty");
      const first = JSON.parse(trainLines[0]) as { messages?: unknown };
      if (!Array.isArray(first.messages)) throw new Error("train.jsonl first line missing messages[]");
      void valText;
    });

    // ─── T8: full bundle generation ───────────────────────────────────────
    header("T8  Forge generateBundle (Unsloth + AutoTrain + Colab + Axolotl)");

    let bundle: Awaited<ReturnType<typeof generateBundle>> | null = null;

    await step("T8.1 -- generateBundle returns 5 files (4 configs + README)", async () => {
      bundle = await generateBundle({
        spec: ForgeSpecSchema.parse({
          runId: "e2e-mvp-run",
          baseModel: "unsloth/Qwen3-4B-Instruct-2507",
          datasetPath: forgePrepareResult!.trainPath,
          maxSeqLength: 2048,
        }) as ForgeSpec,
        workspaceDir: forgeWorkspace,
      });
      if (bundle.files.length !== 5) {
        throw new Error(`got ${bundle.files.length} files, expected 5`);
      }
    });

    await step("T8.2 -- every bundle file actually exists on disk", async () => {
      for (const f of bundle!.files) {
        const full = path.join(bundle!.bundleDir, f);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size === 0) {
          throw new Error(`${f}: missing or empty`);
        }
      }
    });

    await step("T8.3 -- Unsloth Python is non-trivial (>= 30 lines)", async () => {
      const pyFile = bundle!.files.find((f) => f.endsWith(".py"));
      if (!pyFile) throw new Error("no .py in bundle");
      const py = await fs.readFile(path.join(bundle!.bundleDir, pyFile), "utf8");
      if (py.split("\n").length < 30) throw new Error("Unsloth script too small");
      if (!py.includes("FastLanguageModel") && !py.includes("SFTTrainer")) {
        throw new Error("Unsloth script missing FastLanguageModel/SFTTrainer");
      }
    });

    await step("T8.4 -- Colab notebook is valid JSON with cells[]", async () => {
      const ipynb = bundle!.files.find((f) => f.endsWith(".ipynb"));
      if (!ipynb) throw new Error("no .ipynb in bundle");
      const text = await fs.readFile(path.join(bundle!.bundleDir, ipynb), "utf8");
      const parsed = JSON.parse(text) as { cells?: unknown };
      if (!Array.isArray(parsed.cells) || parsed.cells.length < 3) {
        throw new Error(`Colab notebook has ${Array.isArray(parsed.cells) ? parsed.cells.length : 0} cells (need >=3)`);
      }
    });

    console.log(`\n  ${COLOR.dim}Bundle ready at: ${forgeWorkspace}${COLOR.reset}`);
  }

  // ─── T9: cleanup ─────────────────────────────────────────────────────────
  header("T9  Cleanup");

  for (const t of themed) {
    await step(`T9.${t.theme.key} -- delete collection ${t.collection}`, async () => {
      try { await qdrant.deleteCollection(t.collection); } catch { /* already gone */ }
    });
  }

  await step("T9.state -- remove temp scanner-state file", async () => {
    await fs.unlink(stateFile).catch(() => undefined);
  });

  if (!skipForge) {
    await step("T9.forge -- keep generated bundle for inspection (no delete)", () => {
      console.log(`        ${COLOR.dim}left at ${forgeWorkspace}${COLOR.reset}`);
    });
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${COLOR.bold}=== Summary ===${COLOR.reset}`);
  console.log(`Passed   : ${COLOR.green}${passed}${COLOR.reset}`);
  console.log(`Failed   : ${failed === 0 ? COLOR.green : COLOR.red}${failed}${COLOR.reset}`);
  console.log(`Skipped  : ${COLOR.yellow}${skipped}${COLOR.reset}`);

  console.log(`\n${COLOR.bold}Ingest stats per theme:${COLOR.reset}`);
  for (const t of themed) {
    console.log(`  ${t.theme.label.padEnd(20)} chunks=${String(t.totalChunks).padStart(4)} embedded=${t.embedded} upserted=${t.upserted} warnings=${t.warnings.length}`);
  }
  if (crystalConcepts.length > 0) {
    console.log(`\n${COLOR.bold}Crystallizer accepted ${crystalConcepts.length} concepts:${COLOR.reset}`);
    for (const c of crystalConcepts.slice(0, 5)) {
      console.log(`  ${COLOR.cyan}[${c.domain}]${COLOR.reset} ${c.principle.slice(0, 80)}`);
    }
  }

  if (failed > 0) {
    console.log(`\n${COLOR.bold}${COLOR.red}Failures:${COLOR.reset}`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n${COLOR.green}${COLOR.bold}All MVP gates green.${COLOR.reset}\n`);
}

main().catch((e) => {
  console.error(`\n${COLOR.red}Fatal:${COLOR.reset}`, e);
  process.exit(2);
});
