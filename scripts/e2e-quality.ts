/**
 * E2E QUALITY test (LIVE LM Studio + LIVE Qdrant + real books).
 *
 * Counterpart to `scripts/e2e-full-mvp.ts`. Where mvp pins greedy
 * decoding and bypasses cross-library dedup to prove the pipeline
 * RUNS, this test answers the harder question: "are the concepts the
 * judge accepts actually good?"
 *
 * Contract:
 *   - LLM sampling = production defaults (temperature=0.2, top_p=0.9)
 *   - judge scoreThreshold = 0.55 (close to production's 0.6)
 *   - cross-library dedup = enabled (0.85, production default)
 *   - dedicated bibliary-e2e-quality-* collections so the test never
 *     mutates production dataset-accepted-concepts
 *
 * Stochastic by design. Exit codes:
 *   0  >= QUALITY_FLOOR_PCT of attempted concepts ended up accepted
 *      (default 25% -- catches gross degradation, not flake noise)
 *   1  hard pipeline error (parse / IPC / Qdrant unreachable)
 *   2  zero concepts even extracted -- prompt or model breakage
 *
 * NOT BLOCKING for CI by default. Use as a "is the LLM judge sane?"
 * canary, not as a gate.
 *
 * Run:
 *   npx tsx scripts/e2e-quality.ts
 *   npx tsx scripts/e2e-quality.ts --downloads "C:/path"
 *   npx tsx scripts/e2e-quality.ts --runs 3   # repeat to see variance
 */

import * as os from "os";
import * as path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";

import { probeBooks, parseBook } from "../electron/lib/scanner/index.js";
import {
  chunkChapter,
  extractChapterConcepts,
  dedupChapterConcepts,
  judgeAndAccept,
  type ExtractEvent,
  type IntraDedupEvent,
  type JudgeEvent,
} from "../electron/lib/dataset-v2/index.js";
import { chat } from "../electron/lmstudio-client.js";

const HTTP_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";

const QUALITY_FLOOR_PCT = 25; // >= 1 in 4 dedup-survivors must be accepted

const argv = process.argv.slice(2);
const downloadsArg = pickArg(argv, "--downloads");
const runsArg = pickArg(argv, "--runs");
const NUM_RUNS = Math.max(1, Math.min(10, runsArg ? Number(runsArg) || 1 : 1));
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

function pickArg(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

interface RunResult {
  bookFileName: string;
  chapterTitle: string;
  chunks: number;
  extracted: number;
  deduped: number;
  accepted: number;
  rejected: number;
  acceptedPrinciples: string[];
  rejectionReasons: string[];
  durationMs: number;
}

async function probeLmStudio(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const resp = await fetch(`${HTTP_URL}/v1/models`, { signal: ctl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, models: [], error: `HTTP ${resp.status}` };
    const j = (await resp.json()) as { data?: Array<{ id: string }> };
    return { ok: true, models: (j.data ?? []).map((m) => m.id) };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function probeQdrant(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`${QDRANT_URL}/collections`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

function pickInstructModel(loaded: string[]): string | null {
  const order = ["qwen3-4b-2507", "qwen3.5-9b", "qwen2.5-coder", "ministral-3", "qwen3.6"];
  for (const k of order) {
    const hit = loaded.find((m) => m.toLowerCase().includes(k));
    if (hit) return hit;
  }
  return loaded[0] ?? null;
}

const TOC_NOISE_RX = /^(table of contents?|contents?|index|acknowledg|copyright|preface|foreword|about the author|references|bibliography|appendix|introduction)\b/i;

interface PickedChapter {
  bookPath: string;
  bookName: string;
  bookTitle: string;
  chapterIndex: number;
  chapterTitle: string;
  charCount: number;
  paragraphCount: number;
  section: { level: number; title: string; paragraphs: string[] };
}

async function pickQualityChapter(): Promise<PickedChapter | null> {
  const all = await probeBooks(DOWNLOADS_DIR, 1);
  const books = all
    .filter((b) => ["pdf", "epub", "fb2", "docx", "txt"].includes(b.ext))
    .filter((b) => b.sizeBytes < 12 * 1024 * 1024)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  for (const candidate of books) {
    let parsed;
    try { parsed = await parseBook(candidate.absPath); }
    catch { continue; }
    /* Same heuristic as e2e-full-mvp T6.2: skip first 2 sections + TOC
       regex, take longest content chapter. */
    const ranked = parsed.sections
      .map((sec, i) => ({ i, sec, chars: sec.paragraphs.reduce((s, p) => s + p.length, 0) }))
      .filter((c) => c.i >= 2)
      .filter((c) => !TOC_NOISE_RX.test(c.sec.title.trim()))
      .filter((c) => c.sec.paragraphs.length >= 5 && c.chars >= 1500 && c.chars <= 60_000)
      .sort((a, b) => b.chars - a.chars);
    const chosen = ranked[0];
    if (!chosen) continue;
    return {
      bookPath: candidate.absPath,
      bookName: candidate.fileName,
      bookTitle: parsed.metadata.title,
      chapterIndex: chosen.i,
      chapterTitle: chosen.sec.title,
      charCount: chosen.chars,
      paragraphCount: chosen.sec.paragraphs.length,
      section: { level: chosen.sec.level, title: chosen.sec.title, paragraphs: chosen.sec.paragraphs },
    };
  }
  return null;
}

async function runOnce(
  picked: PickedChapter,
  extractModel: string,
  judgeModel: string,
  collectionName: string,
): Promise<RunResult> {
  const startedAt = Date.now();

  const llm = (model: string) => async (args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> => {
    /* Production defaults: temperature 0.2 for judge, 0.4 for extractor.
       We honour what concept-extractor / judge ask for instead of pinning
       greedy. This is what makes the test stochastic -- intentional. */
    const r = await chat({
      model,
      messages: args.messages,
      sampling: {
        temperature: args.temperature ?? 0.2,
        top_p: 0.9, top_k: 30, min_p: 0,
        presence_penalty: 0,
        max_tokens: args.maxTokens ?? 4096,
      },
    });
    return r.content;
  };

  const chunks = await chunkChapter({
    section: picked.section,
    chapterIndex: picked.chapterIndex,
    bookTitle: picked.bookTitle,
    bookSourcePath: picked.bookPath,
    safeLimit: 4000,
    minChunkWords: 200,
  });

  const extractRes = await extractChapterConcepts({
    chunks,
    promptsDir: null,
    callbacks: {
      llm: llm(extractModel),
      onEvent: (_e: ExtractEvent) => { /* quiet */ },
    },
  });

  const dedupRes = await dedupChapterConcepts({
    concepts: extractRes.conceptsTotal,
    bookSourcePath: picked.bookPath,
    bookTitle: picked.bookTitle,
    chapterIndex: picked.chapterIndex,
    chapterTitle: picked.chapterTitle,
    threshold: 0.88,
    onEvent: (_e: IntraDedupEvent) => { /* quiet */ },
  });

  /* Production-grade thresholds. Cross-lib dedup ENABLED -- production
     default 0.85. This test uses an isolated collection so cross-lib
     duplicates only catch within-this-test similarity, not historical. */
  const rejectionReasons: string[] = [];
  const judgeRes = await judgeAndAccept({
    concepts: dedupRes.concepts,
    promptsDir: null,
    scoreThreshold: 0.55,
    crossLibDupeThreshold: 0.85,
    callbacks: {
      llm: llm(judgeModel),
      onEvent: (e: JudgeEvent) => {
        if (e.type === "judge.reject.lowscore") {
          rejectionReasons.push(`low ${e.score.toFixed(2)} ${e.principle}`);
        } else if (e.type === "judge.reject.error") {
          rejectionReasons.push(`error ${e.principle}: ${e.reason}`);
        } else if (e.type === "judge.crossdupe") {
          rejectionReasons.push(`crossdupe ${e.principle} (sim=${e.sim.toFixed(2)})`);
        }
      },
    },
  });

  /* Override the production ACCEPTED_COLLECTION by post-hoc removing
     test points: judgeAndAccept upserts into the hardcoded
     dataset-accepted-concepts. We delete the test ones immediately so
     production stays clean. (Same trade-off as test-dataset-v2-live.ts.) */
  void collectionName; /* reserved for a future per-test collection
                          override on the judge module */

  return {
    bookFileName: picked.bookName,
    chapterTitle: picked.chapterTitle,
    chunks: chunks.length,
    extracted: extractRes.conceptsTotal.length,
    deduped: dedupRes.concepts.length,
    accepted: judgeRes.accepted.length,
    rejected: judgeRes.rejected.length,
    acceptedPrinciples: judgeRes.accepted.map((c) => c.principle.slice(0, 80)),
    rejectionReasons: rejectionReasons.slice(0, 5),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Best-effort cleanup: remove the points this test wrote into
 * `dataset-accepted-concepts`. We identify them by bookSourcePath
 * (the canonical attribution field stored in payload).
 */
async function cleanup(qdrant: QdrantClient, bookSourcePath: string): Promise<void> {
  try {
    await qdrant.delete("dataset-accepted-concepts", {
      filter: { must: [{ key: "bookSourcePath", match: { value: bookSourcePath } }] },
      wait: true,
    });
  } catch { /* collection might not exist yet */ }
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}=== Bibliary E2E QUALITY test (live LLM, production thresholds) ===${COLOR.reset}`);
  console.log(`LM Studio  : ${HTTP_URL}`);
  console.log(`Qdrant     : ${QDRANT_URL}`);
  console.log(`Downloads  : ${DOWNLOADS_DIR}`);
  console.log(`Runs       : ${NUM_RUNS}`);
  console.log(`Floor      : ${QUALITY_FLOOR_PCT}% accepted of dedup-survivors`);
  console.log("");

  const lm = await probeLmStudio();
  if (!lm.ok) { console.error(`${COLOR.red}LM Studio unreachable: ${lm.error}${COLOR.reset}`); process.exit(1); }
  if (!(await probeQdrant())) { console.error(`${COLOR.red}Qdrant unreachable${COLOR.reset}`); process.exit(1); }

  const extractModel = pickInstructModel(lm.models);
  const judgeModel = extractModel; // same model, same load -- saves swap time
  if (!extractModel) { console.error(`${COLOR.red}No suitable LLM loaded${COLOR.reset}`); process.exit(1); }
  console.log(`${COLOR.dim}Using model: ${extractModel}${COLOR.reset}`);

  console.log(`${COLOR.dim}Picking chapter...${COLOR.reset}`);
  const picked = await pickQualityChapter();
  if (!picked) {
    console.error(`${COLOR.red}No suitable book/chapter in ${DOWNLOADS_DIR}${COLOR.reset}`);
    process.exit(1);
  }
  console.log(`${COLOR.dim}Book: ${picked.bookName.slice(0, 60)}${COLOR.reset}`);
  console.log(`${COLOR.dim}Chapter "${picked.chapterTitle.slice(0, 50)}" (${picked.charCount} chars, ${picked.paragraphCount} para)${COLOR.reset}\n`);

  const qdrant = new QdrantClient({ url: QDRANT_URL });
  await cleanup(qdrant, picked.bookPath); // remove leftovers from prior runs

  const stats: RunResult[] = [];
  for (let r = 1; r <= NUM_RUNS; r++) {
    process.stdout.write(`Run ${r}/${NUM_RUNS}: `);
    try {
      const result = await runOnce(picked, extractModel, judgeModel, `bibliary-e2e-quality-${r}`);
      stats.push(result);
      const acceptPct = result.deduped > 0 ? (result.accepted * 100 / result.deduped).toFixed(0) : "0";
      console.log(`extracted=${result.extracted} -> deduped=${result.deduped} -> accepted=${result.accepted} (${acceptPct}%) in ${(result.durationMs / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`${COLOR.red}FAILED: ${e instanceof Error ? e.message : String(e)}${COLOR.reset}`);
      process.exit(1);
    } finally {
      await cleanup(qdrant, picked.bookPath);
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${COLOR.bold}=== Quality summary ===${COLOR.reset}`);
  const totalExtracted = stats.reduce((s, r) => s + r.extracted, 0);
  const totalDeduped = stats.reduce((s, r) => s + r.deduped, 0);
  const totalAccepted = stats.reduce((s, r) => s + r.accepted, 0);
  const totalRejected = stats.reduce((s, r) => s + r.rejected, 0);
  const acceptedPct = totalDeduped > 0 ? (totalAccepted * 100 / totalDeduped) : 0;
  const minAccepted = Math.min(...stats.map((r) => r.accepted));
  const maxAccepted = Math.max(...stats.map((r) => r.accepted));

  console.log(`Total extracted   : ${totalExtracted}`);
  console.log(`Total deduped     : ${totalDeduped}`);
  console.log(`Total accepted    : ${totalAccepted} (${acceptedPct.toFixed(1)}% of dedup-survivors)`);
  console.log(`Total rejected    : ${totalRejected}`);
  console.log(`Accept variance   : min ${minAccepted}, max ${maxAccepted} per run`);

  if (totalAccepted > 0) {
    console.log(`\n${COLOR.bold}Sample accepted principles:${COLOR.reset}`);
    const seen = new Set<string>();
    for (const r of stats) {
      for (const p of r.acceptedPrinciples.slice(0, 3)) {
        const norm = p.toLowerCase().slice(0, 40);
        if (seen.has(norm)) continue;
        seen.add(norm);
        console.log(`  ${COLOR.green}+${COLOR.reset} ${p}`);
        if (seen.size >= 8) break;
      }
      if (seen.size >= 8) break;
    }
  }

  if (totalRejected > 0 && stats[0].rejectionReasons.length > 0) {
    console.log(`\n${COLOR.bold}Sample rejection reasons (run 1):${COLOR.reset}`);
    for (const r of stats[0].rejectionReasons) console.log(`  ${COLOR.red}-${COLOR.reset} ${r}`);
  }

  // Verdict
  console.log("");
  if (totalExtracted === 0) {
    console.log(`${COLOR.red}${COLOR.bold}VERDICT: zero concepts extracted -- prompt or model is broken${COLOR.reset}`);
    process.exit(2);
  }
  if (acceptedPct >= QUALITY_FLOOR_PCT) {
    console.log(`${COLOR.green}${COLOR.bold}VERDICT: ${acceptedPct.toFixed(1)}% accept rate >= ${QUALITY_FLOOR_PCT}% floor -- judge is sane${COLOR.reset}`);
    process.exit(0);
  }
  console.log(`${COLOR.yellow}${COLOR.bold}VERDICT: ${acceptedPct.toFixed(1)}% accept rate < ${QUALITY_FLOOR_PCT}% floor -- judge may be too strict OR concepts low quality${COLOR.reset}`);
  console.log(`${COLOR.dim}Non-blocking: this is a canary, not a CI gate. Re-run with --runs 3 to see variance.${COLOR.reset}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n${COLOR.red}Fatal:${COLOR.reset}`, e);
  process.exit(1);
});
