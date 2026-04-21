/**
 * Phase 2.5R.6 — Roles shape test (живой LM Studio).
 * Run: `npx tsx scripts/test-roles-shape.ts [chunkCount]`
 *
 * Тестирует, что per-phase role prompts (T1/T2/T3) дают тексты правильной формы:
 *  - T1: длина 600-1500 символов, нет '?', нет emoji
 *  - T2: заканчивается '?', длина 30-400, не больше 3 предложений
 *  - T3: длина < 200, ≤ 25 слов, нет '?', нет '\n\n'
 *
 * Floor — 70% (с двумя моделями и без few-shot модель может ошибаться).
 * При запуске без LM Studio падает gracefully.
 */
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { initResilienceLayer } from "../electron/lib/resilience/index.js";
import { getPromptStore } from "../electron/lib/prompts/store.js";
import { chat, getServerStatus, listLoaded } from "../electron/lmstudio-client.js";
import { PHASES, type ChunkPhase } from "../electron/dataset-generator-config.js";

const FLOOR_PERCENT = 0.7;
const DEFAULT_CHUNKS = 3;

interface TestChunk {
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
}

const SAMPLE_CHUNKS: TestChunk[] = [
  {
    principle: "Cache invalidation by event, not by TTL — preserves freshness without staleness window.",
    explanation: "X.perf|cache_invalidation: event-driven >> TTL-based; NO: long_TTL_for_volatile_data; eg: webhook_invalidate >> ttl_60s",
    domain: "perf",
    tags: ["caching", "invalidation", "events"],
  },
  {
    principle: "Lead with verbs in CTAs — telegraph the action, not the object.",
    explanation: "X.copy|cta_verb: action_first >> noun_first; NO: 'Free trial' alone; eg: 'Start free trial' >> 'Free trial available'",
    domain: "copy",
    tags: ["cta", "copywriting", "buttons"],
  },
  {
    principle: "Place primary navigation at thumb reach on mobile — tab bar bottom over hamburger top.",
    explanation: "X.mobile|nav_thumb_reach: bottom_tabs >> top_hamburger; NO: hamburger_only_on_mobile; eg: bottom_4_tab_bar >> top_left_burger",
    domain: "mobile",
    tags: ["navigation", "mobile", "thumb-zone"],
  },
];

function checkT1(text: string): { ok: boolean; reason?: string } {
  const len = text.length;
  if (len < 300 || len > 2500) return { ok: false, reason: `length=${len} not in [300, 2500]` };
  if (text.includes("?")) return { ok: false, reason: "contains '?'" };
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return { ok: false, reason: "contains emoji" };
  return { ok: true };
}

function checkT2(text: string): { ok: boolean; reason?: string } {
  const trimmed = text.trim();
  if (trimmed.length < 20 || trimmed.length > 600) return { ok: false, reason: `length=${trimmed.length} not in [20, 600]` };
  if (!/[?]\s*$/.test(trimmed)) return { ok: false, reason: "does not end with '?'" };
  const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length > 5) return { ok: false, reason: `${sentences.length} sentences > 5` };
  return { ok: true };
}

function checkT3(text: string): { ok: boolean; reason?: string } {
  const trimmed = text.trim();
  if (trimmed.length > 300) return { ok: false, reason: `length=${trimmed.length} > 300` };
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length > 35) return { ok: false, reason: `${words.length} words > 35` };
  if (trimmed.includes("?")) return { ok: false, reason: "contains '?'" };
  if (trimmed.includes("\n\n")) return { ok: false, reason: "contains paragraph break" };
  return { ok: true };
}

function buildPrompt(spec: { voice: string; format: string; exemplar: string; anti_examples: string[] }, chunk: TestChunk, type: ChunkPhase): string {
  const antiList = spec.anti_examples.slice(0, 3).map((a) => `- ${a}`).join("\n");
  const chunkJson = JSON.stringify(chunk, null, 2);
  return `TASK: Generate a ${type} input for a MECHANICUS training pair.

VOICE: ${spec.voice}
FORMAT: ${spec.format}

GOOD EXAMPLE OF ${type}:
${spec.exemplar}

DO NOT WRITE LIKE THIS (these are wrong):
${antiList}

TARGET MECHANICUS CHUNK:
${chunkJson}

Now generate ONLY the ${type} text. No labels. No JSON. No commentary. No markdown fences.`;
}

async function main(): Promise<void> {
  const chunkCount = parseInt(process.argv[2] || String(DEFAULT_CHUNKS), 10);
  const chunks = SAMPLE_CHUNKS.slice(0, Math.min(chunkCount, SAMPLE_CHUNKS.length));

  console.log("Phase 2.5R.6 — Roles shape (живой LM Studio)");

  const status = await getServerStatus();
  if (!status.online) {
    console.error("LM Studio offline. Start it on http://localhost:1234 first.");
    process.exit(1);
  }
  console.log(`  LM Studio v${status.version ?? "?"}`);

  const loaded = await listLoaded();
  if (loaded.length === 0) {
    console.error("No loaded model. Load any chat model in LM Studio.");
    process.exit(1);
  }
  const modelKey = loaded[0].modelKey;
  console.log(`  Using model: ${modelKey}`);

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await initResilienceLayer({
    dataDir: path.join(projectRoot, "data"),
    defaultsDir: path.join(projectRoot, "electron", "defaults"),
  });
  const roles = await getPromptStore().readDatasetRoles();

  const checkers: Record<ChunkPhase, (t: string) => { ok: boolean; reason?: string }> = {
    T1: checkT1,
    T2: checkT2,
    T3: checkT3,
  };

  const results: Array<{ chunk: number; phase: ChunkPhase; ok: boolean; reason?: string; preview: string }> = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`\n[chunk ${i + 1}/${chunks.length}] ${chunk.domain}: ${chunk.principle.slice(0, 60)}...`);
    for (const phase of PHASES) {
      const spec = roles[phase];
      const userPrompt = buildPrompt(spec, chunk, phase);
      try {
        const response = await chat({
          model: modelKey,
          messages: [
            { role: "system", content: spec.system },
            { role: "user", content: userPrompt },
          ],
          sampling: spec.sampling,
        });
        const text = response.content.trim();
        const verdict = checkers[phase](text);
        const tag = verdict.ok ? "OK" : `BAD (${verdict.reason})`;
        console.log(`  ${phase}: ${tag} — "${text.slice(0, 80).replace(/\n/g, " ")}..."`);
        results.push({
          chunk: i + 1,
          phase,
          ok: verdict.ok,
          reason: verdict.reason,
          preview: text.slice(0, 200),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ${phase}: ERROR — ${msg}`);
        results.push({ chunk: i + 1, phase, ok: false, reason: `error: ${msg}`, preview: "" });
      }
    }
  }

  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const ratio = total > 0 ? ok / total : 0;
  console.log(`\n--- Summary ---`);
  console.log(`OK: ${ok}/${total} (${(ratio * 100).toFixed(0)}%)`);
  console.log(`Floor: ${(FLOOR_PERCENT * 100).toFixed(0)}%`);

  if (ratio < FLOOR_PERCENT) {
    console.error("FAIL: roles produce wrong shape too often");
    for (const r of results.filter((x) => !x.ok)) {
      console.error(`  chunk ${r.chunk} ${r.phase}: ${r.reason}`);
    }
    process.exit(1);
  }

  console.log("PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
