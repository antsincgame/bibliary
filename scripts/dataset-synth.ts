/**
 * Iter 8 — Dataset Synthesis: Qdrant collection → ChatML JSONL для LoRA-тренировки.
 *
 * Финальный payoff Pre-flight Evaluation pipeline. Берёт принятые концепты
 * из тематической Qdrant-коллекции (например `marketing-concepts`),
 * генерирует через LLM 1-3 Q&A пары на каждый концепт, опционально
 * сохраняет reasoning_trace эпистемолога/судьи как `<think>` блок в
 * assistant-ответе (R1-style premium distillation data).
 *
 * Контракт ChatML JSONL (один объект на строку):
 *   { "messages": [
 *       { "role": "system",    "content": "..." },
 *       { "role": "user",      "content": "<question>" },
 *       { "role": "assistant", "content": "<think>...</think>\n\n<answer>" }
 *     ],
 *     "meta": { "concept_id": "...", "domain": "...", "source_book": "..." }
 *   }
 *
 * Полностью реальный код. Никаких моков. Использует:
 *   - Qdrant scroll API → честно качает все принятые концепты
 *   - LM Studio (chatWithPolicy) → реальные генерации
 *   - assertValidCollectionName → защита от мусорного --collection
 *   - file streaming → JSONL пишется построчно (не упадёт на 50K концептах)
 *
 * Запуск:
 *   npm run dataset:synth -- --collection marketing-concepts \
 *                            --out release/datasets/marketing.jsonl \
 *                            --pairs-per-concept 2 \
 *                            [--include-reasoning] [--limit 100]
 */

import { promises as fs, createWriteStream } from "fs";
import * as path from "path";
import { z } from "zod";
import { chatWithPolicy } from "../electron/lmstudio-client.js";
import { fetchQdrantJson, QDRANT_URL } from "../electron/lib/qdrant/http-client.js";
import { assertValidCollectionName } from "../electron/lib/dataset-v2/judge.js";
import { pickEvaluatorModel } from "../electron/lib/library/book-evaluator.js";

// ── ANSI colors ─────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", magenta: "\x1b[35m",
};

// ── CLI args ────────────────────────────────────────────────────────────────
interface Args {
  collection: string;
  out: string;
  pairsPerConcept: number;
  includeReasoning: boolean;
  limit?: number;
  model?: string;
  systemPromptFile?: string;
  preset: string;
  presetsDir?: string;
  listPresets: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    collection: "dataset-accepted-concepts",
    out: "release/datasets/synth.jsonl",
    pairsPerConcept: 2,
    includeReasoning: false,
    preset: "auto",
    listPresets: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--collection":         a.collection = String(v); i++; break;
      case "--out":                a.out = String(v); i++; break;
      case "--pairs-per-concept":  a.pairsPerConcept = Math.max(1, Math.min(5, Number(v) || 2)); i++; break;
      case "--include-reasoning":  a.includeReasoning = true; break;
      case "--limit":              a.limit = Math.max(1, Number(v) || 0); i++; break;
      case "--model":              a.model = String(v); i++; break;
      case "--system-prompt-file": a.systemPromptFile = String(v); i++; break;
      case "--preset":             a.preset = String(v).toLowerCase(); i++; break;
      case "--presets-dir":        a.presetsDir = String(v); i++; break;
      case "--list-presets":       a.listPresets = true; break;
      case "--help":
      case "-h":                   a.help = true; break;
    }
  }
  return a;
}

function printHelp() {
  console.log(`
${C.bold}Iter 8/9 — Dataset Synthesis (Qdrant → ChatML JSONL)${C.reset}

Usage:
  npm run dataset:synth -- --collection <name> --out <file.jsonl> [options]

Options:
  --collection <name>          Qdrant collection name (default: dataset-accepted-concepts)
  --out <path>                 Output .jsonl file (default: release/datasets/synth.jsonl)
  --pairs-per-concept <1..5>   How many Q/A pairs per concept (default: 2)
  --include-reasoning          Wrap assistant in <think>...</think> from reasoning_trace
                                (R1-style premium distillation data)
  --limit <N>                  Stop after N concepts (default: all)
  --model <modelKey>           LM Studio model override (default: pickEvaluatorModel)
  --preset <name>              Trainer system-prompt preset (default: auto).
                                Available: auto | none | default | <preset-name>.
                                'auto'    — pick by concept.domain (multi-tenant LoRA factory).
                                'none'    — minimal generic prompt (back-compat).
                                'default' — use 'default' preset for all concepts.
  --presets-dir <path>         Override location of synth-prompts directory.
  --list-presets               List all available presets and exit.
  --system-prompt-file <path>  Hardcoded prompt file overriding presets entirely.
  -h, --help                   Show this help

Output (ChatML JSONL):
  { "messages": [{role,content}, ...], "meta": {concept_id, domain, source_book, preset} }

Ready for Unsloth / LlamaFactory / axolotl LoRA training.
`);
}

// ── Preset infrastructure (Iter 9: per-domain trainer prompts) ──────────────

interface PresetEntry {
  file: string;
  label: string;
  matchDomains: string[];
}

interface PresetIndex {
  presets: Record<string, PresetEntry>;
}

interface LoadedPreset {
  name: string;
  label: string;
  template: string;
}

const FALLBACK_DEFAULT_PROMPT =
  "You are an expert in {{domain}}. Provide rigorous, actionable answers grounded in established principles. " +
  "When appropriate, briefly cite the underlying concept (one sentence) before giving the practical implication.";

function presetCandidates(override?: string): string[] {
  const arr: string[] = [];
  if (override) arr.push(path.resolve(override));
  if (process.env.BIBLIARY_DEFAULTS_DIR) {
    arr.push(path.join(process.env.BIBLIARY_DEFAULTS_DIR, "synth-prompts"));
  }
  arr.push(path.resolve(process.cwd(), "electron", "defaults", "synth-prompts"));
  return arr;
}

async function locatePresetsDir(override?: string): Promise<string | null> {
  for (const c of presetCandidates(override)) {
    try {
      const idx = path.join(c, "index.json");
      await fs.access(idx);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function loadPresetIndex(dir: string): Promise<PresetIndex> {
  const raw = await fs.readFile(path.join(dir, "index.json"), "utf8");
  const parsed = JSON.parse(raw) as PresetIndex;
  if (!parsed.presets || typeof parsed.presets !== "object") {
    throw new Error(`presets index.json: missing 'presets' object`);
  }
  return parsed;
}

async function loadPresetTemplate(dir: string, entry: PresetEntry): Promise<string> {
  const raw = await fs.readFile(path.join(dir, entry.file), "utf8");
  return raw.trim();
}

/**
 * Map a concept's `domain` string to the best-matching preset name.
 *
 * Algorithm:
 *   1. Lowercase + tokenize domain.
 *   2. For each preset, score = number of overlapping keywords.
 *   3. Return preset with highest score, ties broken by definition order
 *      (more specific presets first in index.json).
 *   4. If no overlap → "default".
 */
function pickPresetForDomain(domain: string, index: PresetIndex): string {
  const dom = domain.toLowerCase();
  let bestName = "default";
  let bestScore = 0;
  for (const [name, entry] of Object.entries(index.presets)) {
    if (name === "default") continue;
    let score = 0;
    for (const kw of entry.matchDomains) {
      if (dom.includes(kw.toLowerCase())) score += kw.length; /* longer match = more specific */
    }
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  return bestName;
}

class PresetResolver {
  private cache = new Map<string, LoadedPreset>();
  constructor(
    private dir: string,
    private index: PresetIndex,
    private mode: "auto" | "fixed" | "none",
    private fixedName?: string,
  ) {}

  static async create(args: Args): Promise<PresetResolver> {
    /* --system-prompt-file overrides preset infrastructure entirely. */
    if (args.systemPromptFile) {
      const tmpl = (await fs.readFile(args.systemPromptFile, "utf8")).trim();
      const fakeIdx: PresetIndex = {
        presets: { custom: { file: "(inline)", label: "Custom file", matchDomains: [] } },
      };
      const r = new PresetResolver("(inline)", fakeIdx, "fixed", "custom");
      r.cache.set("custom", { name: "custom", label: "Custom file", template: tmpl });
      return r;
    }

    if (args.preset === "none") {
      const fakeIdx: PresetIndex = {
        presets: { none: { file: "(builtin)", label: "Generic", matchDomains: [] } },
      };
      const r = new PresetResolver("(builtin)", fakeIdx, "fixed", "none");
      r.cache.set("none", { name: "none", label: "Generic", template: FALLBACK_DEFAULT_PROMPT });
      return r;
    }

    const dir = await locatePresetsDir(args.presetsDir);
    if (!dir) {
      console.warn(
        `${C.yellow}[presets]${C.reset} no synth-prompts/ directory found; falling back to generic prompt.`,
      );
      const fakeIdx: PresetIndex = {
        presets: { fallback: { file: "(builtin)", label: "Generic fallback", matchDomains: [] } },
      };
      const r = new PresetResolver("(builtin)", fakeIdx, "fixed", "fallback");
      r.cache.set("fallback", {
        name: "fallback",
        label: "Generic fallback",
        template: FALLBACK_DEFAULT_PROMPT,
      });
      return r;
    }

    const index = await loadPresetIndex(dir);

    if (args.preset === "auto") {
      return new PresetResolver(dir, index, "auto");
    }

    /* Explicit named preset (--preset marketing). */
    const entry = index.presets[args.preset];
    if (!entry) {
      const known = Object.keys(index.presets).join(", ");
      throw new Error(`unknown preset '${args.preset}'. Available: ${known}`);
    }
    return new PresetResolver(dir, index, "fixed", args.preset);
  }

  /** Load preset by name (cached). Returns the loaded preset. */
  async load(name: string): Promise<LoadedPreset> {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const entry = this.index.presets[name];
    if (!entry) {
      /* Defensive: preset file disappeared or auto picked unknown. Use default. */
      const def = this.index.presets["default"];
      if (!def) throw new Error(`No 'default' preset and requested '${name}' missing.`);
      const template = await loadPresetTemplate(this.dir, def);
      const out: LoadedPreset = { name: "default", label: def.label, template };
      this.cache.set("default", out);
      return out;
    }
    const template = await loadPresetTemplate(this.dir, entry);
    const out: LoadedPreset = { name, label: entry.label, template };
    this.cache.set(name, out);
    return out;
  }

  /** Resolve preset for a given concept domain. */
  async resolve(domain: string): Promise<LoadedPreset> {
    if (this.mode === "fixed" && this.fixedName) return this.load(this.fixedName);
    const picked = pickPresetForDomain(domain, this.index);
    return this.load(picked);
  }

  /** Show an inventory of presets with their match keywords. */
  describeAvailable(): { name: string; label: string; keywords: string[] }[] {
    return Object.entries(this.index.presets).map(([name, entry]) => ({
      name,
      label: entry.label,
      keywords: entry.matchDomains,
    }));
  }

  get modeLabel(): string {
    if (this.mode === "auto") return "auto (per-domain)";
    if (this.mode === "fixed" && this.fixedName) return `fixed: ${this.fixedName}`;
    return this.mode;
  }
}

// ── LLM synthesis prompt (asks the model to produce N Q&A pairs in JSON) ────
const SYNTH_SYSTEM_PROMPT = `You are a Senior Curriculum Designer building a high-signal LoRA training dataset.

Given ONE conceptual principle (with explanation, source quote, domain), generate {{N}} pedagogically-distinct Question/Answer pairs that train a model to apply this concept.

RULES:
1. Each Q is a realistic prompt a practitioner would actually ask (not a quiz).
2. Each A is a substantive answer (3-7 sentences) that uses the principle without naming it pedantically.
3. Q diversity: vary the angle — application, edge case, comparison, troubleshooting.
4. NEVER copy the source quote verbatim into the answer. Paraphrase.
5. Keep answers domain-specific. No generic motivational language.
6. Output STRICT JSON. NO prose before or after.

OUTPUT SCHEMA:
{
  "pairs": [
    { "question": "...", "answer": "..." },
    ...
  ]
}`;

const SynthSchema = z.object({
  pairs: z
    .array(
      z.object({
        question: z.string().min(15).max(800),
        answer: z.string().min(60).max(3000),
      })
    )
    .min(1)
    .max(5),
});

// ── Qdrant scroll: stream all points (paged) ────────────────────────────────
interface QdrantPoint {
  id: string | number;
  payload?: Record<string, unknown>;
}

interface ScrollResponse {
  result: {
    points: QdrantPoint[];
    next_page_offset?: string | number | null;
  };
}

async function* scrollAllPoints(
  collection: string,
  pageSize = 256,
): AsyncGenerator<QdrantPoint, void, unknown> {
  let offset: string | number | null | undefined = undefined;
  for (;;) {
    const body: Record<string, unknown> = {
      limit: pageSize,
      with_payload: true,
      with_vector: false,
    };
    if (offset !== undefined && offset !== null) body.offset = offset;

    const data = await fetchQdrantJson<ScrollResponse>(
      `${QDRANT_URL}/collections/${collection}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      },
    );
    for (const p of data.result.points) yield p;
    offset = data.result.next_page_offset ?? null;
    if (!offset) return;
  }
}

// ── Concept payload extraction (defensive — old/new schema both supported) ──
interface ConceptPayload {
  conceptId: string;
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
  noveltyHint?: string;
  sourceQuote?: string;
  sourceBook?: string;
  chapterTitle?: string;
  extractorReasoning?: string;
  judgeReasoningTrace?: string;
}

function extractConceptPayload(point: QdrantPoint): ConceptPayload | null {
  const p = (point.payload ?? {}) as Record<string, unknown>;
  const principle = String(p.principle ?? "").trim();
  const explanation = String(p.explanation ?? "").trim();
  const domain = String(p.domain ?? "").trim();
  if (!principle || !explanation || !domain) return null;

  const tags = Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : [];
  return {
    conceptId: String(point.id),
    principle,
    explanation,
    domain,
    tags,
    noveltyHint: p.noveltyHint ? String(p.noveltyHint) : undefined,
    sourceQuote: p.sourceQuote ? String(p.sourceQuote) : undefined,
    sourceBook: p.bookTitle ? String(p.bookTitle) : (p.bookSourcePath ? String(p.bookSourcePath) : undefined),
    chapterTitle: p.chapterTitle ? String(p.chapterTitle) : undefined,
    extractorReasoning: p.extractorReasoning ? String(p.extractorReasoning) : undefined,
    judgeReasoningTrace: p.judgeReasoningTrace ? String(p.judgeReasoningTrace) : undefined,
  };
}

// ── Build the synthesis user message ────────────────────────────────────────
function buildSynthUserMessage(c: ConceptPayload, pairsN: number): string {
  const lines = [
    `Generate ${pairsN} Q/A pairs for the following concept.`,
    ``,
    `DOMAIN: ${c.domain}`,
    `PRINCIPLE: ${c.principle}`,
    `EXPLANATION: ${c.explanation}`,
  ];
  if (c.tags.length > 0) lines.push(`TAGS: ${c.tags.join(", ")}`);
  if (c.noveltyHint)     lines.push(`NOVELTY ANGLE: ${c.noveltyHint}`);
  if (c.sourceQuote)     lines.push(`SOURCE QUOTE (do NOT copy verbatim): "${c.sourceQuote}"`);
  return lines.join("\n");
}

// ── Strict JSON extraction from raw LLM output ──────────────────────────────
function extractJson(raw: string): unknown | null {
  if (!raw) return null;
  /* Strip optional <think>...</think> first. */
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  /* Find first `{` and matching last `}`. */
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = cleaned.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

// ── ChatML JSONL writer (streaming, one line per training example) ──────────
interface TrainingExample {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  meta: {
    concept_id: string;
    domain: string;
    source_book?: string;
    tags: string[];
    has_reasoning: boolean;
  };
}

function buildAssistantContent(answer: string, reasoningTrace?: string, includeReasoning?: boolean): string {
  if (!includeReasoning || !reasoningTrace) return answer;
  /* R1-style: thought process first inside <think>, then the answer.
     The trace from extractor/judge is REUSED here -- it explains how
     the underlying concept was discovered, which is exactly the kind
     of meta-reasoning we want the student model to absorb. */
  const trimmed = reasoningTrace.trim();
  if (trimmed.length === 0) return answer;
  return `<think>\n${trimmed}\n</think>\n\n${answer}`;
}

interface TrainingMeta {
  concept_id: string;
  domain: string;
  source_book?: string;
  tags: string[];
  has_reasoning: boolean;
  preset: string;
}

function buildExample(
  concept: ConceptPayload,
  qa: { question: string; answer: string },
  preset: LoadedPreset,
  includeReasoning: boolean,
): TrainingExample & { meta: TrainingMeta } {
  const reasoning = concept.extractorReasoning || concept.judgeReasoningTrace;
  const sys = preset.template.replace(/\{\{domain\}\}/g, concept.domain);
  const assistantContent = buildAssistantContent(qa.answer, reasoning, includeReasoning);
  return {
    messages: [
      { role: "system",    content: sys },
      { role: "user",      content: qa.question },
      { role: "assistant", content: assistantContent },
    ],
    meta: {
      concept_id: concept.conceptId,
      domain: concept.domain,
      source_book: concept.sourceBook,
      tags: concept.tags,
      has_reasoning: includeReasoning && !!reasoning,
      preset: preset.name,
    },
  };
}

// ── Pre-flight checks ───────────────────────────────────────────────────────
async function preflight(args: Args): Promise<{ model: string; total: number }> {
  console.log(`${C.cyan}[pre-flight]${C.reset} probing services...`);

  /* Validate collection name early — assertValidCollectionName throws on garbage. */
  assertValidCollectionName(args.collection);

  /* Qdrant reachable? Get the points_count to size the run. */
  const meta = await fetchQdrantJson<{ result: { points_count?: number } }>(
    `${QDRANT_URL}/collections/${args.collection}`,
    { timeoutMs: 10_000 },
  );
  const total = meta.result.points_count ?? 0;
  if (total === 0) {
    console.error(`${C.red}${C.bold}FATAL:${C.reset} collection '${args.collection}' is empty.`);
    process.exit(2);
  }

  /* LM Studio model: explicit override OR pickEvaluatorModel (flagship-first). */
  let model = args.model;
  if (!model) {
    const picked = await pickEvaluatorModel();
    if (!picked) {
      console.error(`${C.red}${C.bold}FATAL:${C.reset} no LLM available; pass --model or load one in LM Studio.`);
      process.exit(3);
    }
    model = picked;
  }

  console.log(`${C.cyan}[pre-flight]${C.reset} collection = ${args.collection} (${total} points)`);
  console.log(`${C.cyan}[pre-flight]${C.reset} model      = ${model}`);
  console.log(`${C.cyan}[pre-flight]${C.reset} pairs/cpt  = ${args.pairsPerConcept}`);
  console.log(`${C.cyan}[pre-flight]${C.reset} reasoning  = ${args.includeReasoning ? "preserved" : "stripped"}`);
  console.log(`${C.cyan}[pre-flight]${C.reset} output     = ${path.resolve(args.out)}`);
  if (args.limit) console.log(`${C.cyan}[pre-flight]${C.reset} limit      = ${args.limit}`);

  return { model, total };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  console.log(`${C.bold}=== Bibliary Dataset Synthesis (Iter 9 — multi-tenant) ===${C.reset}\n`);

  /* --list-presets is a quick discovery command — no LLM, no Qdrant required. */
  if (args.listPresets) {
    const dir = await locatePresetsDir(args.presetsDir);
    if (!dir) {
      console.error(`${C.red}No synth-prompts directory found.${C.reset}`);
      process.exit(2);
    }
    const idx = await loadPresetIndex(dir);
    console.log(`${C.dim}from ${dir}${C.reset}\n`);
    for (const [name, entry] of Object.entries(idx.presets)) {
      console.log(`  ${C.bold}${pad(name, 14)}${C.reset} ${entry.label}`);
      if (entry.matchDomains.length > 0) {
        console.log(`  ${pad("", 14)} ${C.dim}matches: ${entry.matchDomains.slice(0, 6).join(", ")}${entry.matchDomains.length > 6 ? "…" : ""}${C.reset}`);
      }
    }
    console.log(`\nUse with --preset <name> | --preset auto (default) | --preset none`);
    return;
  }

  const presets = await PresetResolver.create(args);
  const { model, total } = await preflight(args);
  const cap = args.limit ? Math.min(args.limit, total) : total;

  console.log(`${C.cyan}[pre-flight]${C.reset} preset     = ${presets.modeLabel}`);

  /* Ensure output directory exists, then open a streaming writer. */
  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  const writer = createWriteStream(path.resolve(args.out), { flags: "w", encoding: "utf8" });

  /* Counters for the final report. */
  let processed = 0;
  let synthesized = 0;
  let llmFailures = 0;
  let schemaFailures = 0;
  let payloadSkips = 0;
  const byDomain = new Map<string, number>();
  const byPreset = new Map<string, number>();
  const t0 = Date.now();

  console.log(`\n${C.bold}=== Synthesizing ${cap} concepts ===${C.reset}\n`);

  for await (const point of scrollAllPoints(args.collection, 256)) {
    if (processed >= cap) break;

    const concept = extractConceptPayload(point);
    if (!concept) {
      payloadSkips++;
      continue;
    }
    processed++;

    /* Resolve trainer prompt PER CONCEPT (Iter 9: multi-tenant). */
    let preset: LoadedPreset;
    try {
      preset = await presets.resolve(concept.domain);
    } catch (e) {
      llmFailures++;
      console.error(`${C.red}[${processed}/${cap}] preset resolve failed: ${e instanceof Error ? e.message : e}${C.reset}`);
      continue;
    }

    const userMsg = buildSynthUserMessage(concept, args.pairsPerConcept);
    const synthSysFilled = SYNTH_SYSTEM_PROMPT.replace(/\{\{N\}\}/g, String(args.pairsPerConcept));

    let raw = "";
    try {
      const resp = await chatWithPolicy({
        model,
        messages: [
          { role: "system", content: synthSysFilled },
          { role: "user",   content: userMsg },
        ],
        sampling: { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0, presence_penalty: 0, max_tokens: 4096 },
      });
      raw = resp.content ?? "";
    } catch (err) {
      llmFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${C.red}[${processed}/${cap}] LLM error: ${msg.slice(0, 120)}${C.reset}`);
      continue;
    }

    const parsed = extractJson(raw);
    const validated = SynthSchema.safeParse(parsed);
    if (!validated.success) {
      schemaFailures++;
      console.error(
        `${C.yellow}[${processed}/${cap}] schema fail: ${validated.error.issues.slice(0, 2).map((i) => i.message).join("; ")}${C.reset}`,
      );
      continue;
    }

    const examples = validated.data.pairs.map((qa) =>
      buildExample(concept, qa, preset, args.includeReasoning),
    );
    for (const ex of examples) {
      writer.write(JSON.stringify(ex) + "\n");
      synthesized++;
    }
    byDomain.set(concept.domain, (byDomain.get(concept.domain) ?? 0) + examples.length);
    byPreset.set(preset.name, (byPreset.get(preset.name) ?? 0) + examples.length);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${C.green}[${processed}/${cap}]${C.reset} ${C.dim}${elapsed}s${C.reset} ` +
      `${C.bold}${concept.principle.slice(0, 60)}${concept.principle.length > 60 ? "…" : ""}${C.reset} ` +
      `${C.dim}→ ${examples.length} pairs · ${concept.domain} · ${C.magenta}preset:${preset.name}${C.reset}`,
    );
  }

  await new Promise<void>((res, rej) => writer.end((err: Error | null | undefined) => err ? rej(err) : res()));

  /* ── Final report ─────────────────────────────────────────────────────── */
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${C.bold}=== SYNTHESIS COMPLETE ===${C.reset}`);
  console.log(`Concepts processed   : ${processed}`);
  console.log(`Training examples    : ${C.green}${synthesized}${C.reset}`);
  console.log(`LLM failures         : ${llmFailures > 0 ? C.red : C.dim}${llmFailures}${C.reset}`);
  console.log(`Schema failures      : ${schemaFailures > 0 ? C.yellow : C.dim}${schemaFailures}${C.reset}`);
  console.log(`Empty payloads       : ${C.dim}${payloadSkips}${C.reset}`);
  console.log(`Elapsed              : ${totalSec}s`);
  console.log(`Output               : ${path.resolve(args.out)}`);

  if (byPreset.size > 0) {
    console.log(`\n${C.bold}Examples by preset:${C.reset}`);
    [...byPreset.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([p, n]) => console.log(`  ${pad(p, 18)} ${n}`));
  }

  if (byDomain.size > 0) {
    console.log(`\n${C.bold}Examples by domain (top 15):${C.reset}`);
    [...byDomain.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([d, n]) => console.log(`  ${pad(d, 40)} ${n}`));
  }

  if (synthesized === 0) {
    console.error(`\n${C.red}${C.bold}WARNING:${C.reset} 0 examples synthesized. Check LM Studio + collection contents.`);
    process.exit(4);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

main().catch((e) => {
  console.error(`${C.red}${C.bold}FATAL:${C.reset} ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
