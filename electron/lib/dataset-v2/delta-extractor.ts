/**
 * Delta-Knowledge Extractor — unified pipeline replacing concept-extractor + judge.
 *
 * Per chunk: one LLM call → AURA filter → 0 or 1 DeltaKnowledge record.
 * Per chapter: one LLM call for thesis extraction (macro-context).
 *
 * Rolling chapter memory carries the last few essences found,
 * so the LLM doesn't repeat the same insights across chunks.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { DeltaKnowledgeSchema, type ChapterMemory, type DeltaKnowledge, type SemanticChunk } from "./types.js";
import { ALLOWED_DOMAINS } from "./crystallizer-constants.js";
import { isAbortError } from "../resilience/lm-request-policy.js";
import { extractJsonFromReasoning, extractJsonObjectFromReasoning } from "./reasoning-decoder.js";

export type LlmCallResult = string | { content: string; reasoningContent?: string };

export interface DeltaExtractCallbacks {
  llm: (args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<LlmCallResult>;
  onEvent?: (e: DeltaExtractEvent) => void;
}

export type DeltaExtractEvent =
  | { type: "delta.chunk.start"; chunkPart: number; chunkTotal: number; chapterTitle: string }
  | { type: "delta.chunk.done"; chunkPart: number; chunkTotal: number; accepted: boolean; durationMs: number }
  | { type: "delta.chunk.skip"; chunkPart: number; reason: string }
  | { type: "delta.chunk.error"; chunkPart: number; error: string }
  | { type: "delta.thesis.done"; chapterTitle: string; thesis: string }
  | { type: "delta.retry"; chunkPart: number; attempt: number; reason: string };

/* ─────────────── Prompt loading ─────────────── */

const PROMPT_CACHE = new Map<string, string>();

function bundledCandidates(file: string): string[] {
  const candidates: string[] = [];
  if (process.env.BIBLIARY_PROMPTS_DEFAULT_DIR) {
    candidates.push(path.join(process.env.BIBLIARY_PROMPTS_DEFAULT_DIR, file));
  }
  if (typeof __dirname !== "undefined") {
    candidates.push(path.resolve(__dirname, "..", "..", "defaults", "prompts", file));
  }
  candidates.push(path.resolve(process.cwd(), "electron", "defaults", "prompts", file));
  return candidates;
}

async function loadPrompt(promptsDir: string | null, file: string): Promise<string> {
  const key = `${promptsDir ?? "<bundled>"}:${file}`;
  const cached = PROMPT_CACHE.get(key);
  if (cached) return cached;

  if (promptsDir) {
    try {
      const full = path.join(promptsDir, file);
      const text = await fs.readFile(full, "utf8");
      if (text.trim().length > 50) {
        PROMPT_CACHE.set(key, text);
        return text;
      }
    } catch { /* fallback */ }
  }
  for (const c of bundledCandidates(file)) {
    try {
      const text = await fs.readFile(c, "utf8");
      if (text.trim().length > 50) {
        PROMPT_CACHE.set(key, text);
        return text;
      }
    } catch { /* next */ }
  }
  const candidates = promptsDir ? [path.join(promptsDir, file), ...bundledCandidates(file)] : bundledCandidates(file);
  console.error(`[delta] prompt "${file}" NOT FOUND! Tried:\n${candidates.map(c => `  - ${c}`).join("\n")}`);
  throw new Error(`${file} not found in any prompt location`);
}

export function clearPromptCache(): void { PROMPT_CACHE.clear(); }

/* ─────────────── Thesis extraction ─────────────── */

export async function extractChapterThesis(
  chapterTitle: string,
  chapterText: string,
  cb: DeltaExtractCallbacks,
  promptsDir?: string | null,
): Promise<string> {
  try {
    const template = await loadPrompt(promptsDir ?? null, "chapter-thesis.md");
    const truncated = chapterText.split(/\s+/).slice(0, 2000).join(" ");
    const prompt = template
      .replace("{{CHAPTER_TITLE}}", chapterTitle)
      .replace("{{CHAPTER_TEXT}}", truncated);

    const r = normalizeLlm(await cb.llm({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      maxTokens: 300,
    }));
    const thesis = r.content.trim().slice(0, 200) || "General introduction";
    cb.onEvent?.({ type: "delta.thesis.done", chapterTitle, thesis });
    return thesis;
  } catch (e) {
    if (isAbortError(e)) throw e;
    console.warn(`[delta-extractor] thesis extraction failed for "${chapterTitle}": ${e instanceof Error ? e.message : e}`);
    return "General introduction";
  }
}

/* ─────────────── Per-chunk extraction ─────────────── */

function normalizeLlm(r: LlmCallResult): { content: string; reasoningContent?: string } {
  if (typeof r === "string") return { content: r };
  return { content: r.content ?? "", reasoningContent: r.reasoningContent };
}

function tryParseJson(raw: string): unknown {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  if (cleaned === "null") return null;
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
  return JSON.parse(cleaned);
}

function makeId(bookSourcePath: string, chapterIndex: number, partN: number, partTotal: number, chunkText: string): string {
  const h = createHash("sha1")
    .update(`${bookSourcePath}|${chapterIndex}|${partN}|${partTotal}|${chunkText}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function isMetaNoiseDelta(data: {
  domain: string;
  chapterContext: string;
  essence: string;
  proof: string;
  tags: string[];
}): boolean {
  const text = `${data.domain} ${data.chapterContext} ${data.essence} ${data.proof} ${data.tags.join(" ")}`.toLowerCase();
  return /\b(table of contents|bibliographic|book endorsement|endorsements|marketing material|promotional|publisher blurb|credits|copyright|about the author|about the reviewer|structural metadata)\b/.test(text) ||
    /\b(оглавление|содержание|краткое содержание|библиограф|рекламн|аннотац|об авторах|об авторе)\b/i.test(text);
}

/**
 * Hard-cap на размер ВХОДНОГО prompt. Считаем: 1 token ≈ 3.5 chars (mix RU/EN).
 * Большинство практических LLM имеют контекст ≥ 8k tokens; держим запас под
 * выход модели (4k tokens) и safety margin → ~24 000 chars входа.
 *
 * Если итоговый prompt превышает лимит — режем chunk.text (это самая объёмная
 * часть). Срез детерминированный, по символам, без потери начала чанка.
 *
 * Превышение редкое: возникает только когда в prefs выставлен агрессивный
 * chunkSafeLimit (до 20000 слов = ~80k tokens). Этот guard не ломает обычный
 * сценарий, а защищает от деградации контекста при экстремальных настройках.
 */
const DEFAULT_PROMPT_CHARS_HARD_CAP = 24_000;

export interface BuildPromptResult {
  prompt: string;
  /** True, если CHUNK_TEXT был обрезан под cap. */
  truncated: boolean;
  /** Сколько символов исходного chunk.text реально вошло в prompt. */
  chunkCharsUsed: number;
}

export function buildPromptWithGuard(
  template: string,
  chunk: SemanticChunk,
  thesis: string,
  memory: ChapterMemory,
  maxChars: number = DEFAULT_PROMPT_CHARS_HARD_CAP,
): BuildPromptResult {
  const domains = Array.from(ALLOWED_DOMAINS).sort().join(", ");
  const memoryBlock = memory.ledEssences.length > 0
    ? `Already extracted from earlier chunks in this chapter:\n${memory.ledEssences.map((e) => `- ${e}`).join("\n")}\nDo NOT repeat these.`
    : "";
  const overlapBlock = chunk.overlapText?.trim()
    ? `Context from end of previous chunk:\n"${chunk.overlapText.trim()}"\n(For continuity only — extract from the new chunk below.)`
    : "";

  const skeleton = template
    .replace("{{BREADCRUMB}}", chunk.breadcrumb)
    .replace("{{CHAPTER_THESIS}}", thesis)
    .replace("{{OVERLAP_CONTEXT}}", overlapBlock || memoryBlock)
    .replace("{{ALLOWED_DOMAINS}}", domains);

  const overhead = skeleton.length - "{{CHUNK_TEXT}}".length;
  const availableForChunk = Math.max(2_000, maxChars - overhead);

  let chunkText = chunk.text;
  let truncated = false;
  if (chunkText.length > availableForChunk) {
    chunkText = chunkText.slice(0, availableForChunk) +
      "\n\n[…отрезано: текст чанка превышал безопасный размер контекста LLM]";
    truncated = true;
  }
  return {
    prompt: skeleton.replace("{{CHUNK_TEXT}}", chunkText),
    truncated,
    chunkCharsUsed: chunkText.length,
  };
}

async function tryOneAttempt(
  prompt: string,
  llm: DeltaExtractCallbacks["llm"],
  params: { temperature: number; maxTokens: number },
  _chunkPart: number,
): Promise<
  | { ok: true; raw: string; parsed: unknown }
  | { ok: false; raw: string; reason: string }
> {
  let lm: { content: string; reasoningContent?: string };
  try {
    lm = normalizeLlm(await llm({
      messages: [{ role: "user", content: prompt }],
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    }));
  } catch (e) {
    if (isAbortError(e)) throw e;
    return { ok: false, raw: "", reason: `llm-error: ${e instanceof Error ? e.message : e}` };
  }

  const content = lm.content.trim();
  if (content.length > 0) {
    try {
      return { ok: true, raw: content, parsed: tryParseJson(content) };
    } catch { /* fallthrough to reasoning */ }
  }

  /* Сначала объект: в тексте часто есть массивы (tags, auraFlags) — extractJsonFromReasoning
     взял бы последний [...] и дал бы неверный корень. DeltaKnowledge всегда один JSON-object. */
  const decodedObj = extractJsonObjectFromReasoning(lm.reasoningContent);
  if (decodedObj) {
    try {
      return { ok: true, raw: decodedObj, parsed: JSON.parse(decodedObj) };
    } catch (e) {
      return { ok: false, raw: decodedObj, reason: `reasoning-object-parse: ${e instanceof Error ? e.message : e}` };
    }
  }

  const decoded = extractJsonFromReasoning(lm.reasoningContent);
  if (decoded) {
    try {
      return { ok: true, raw: decoded, parsed: JSON.parse(decoded) };
    } catch (e) {
      return { ok: false, raw: decoded, reason: `reasoning-parse: ${e instanceof Error ? e.message : e}` };
    }
  }

  if (content === "null" || content === "") {
    return { ok: true, raw: "null", parsed: null };
  }
  return { ok: false, raw: content, reason: "json-parse-failed" };
}

interface ChunkResult {
  chunk: SemanticChunk;
  delta: DeltaKnowledge | null;
  raw: string;
  warnings: string[];
}

const MAX_TOKENS = 4096;
const RETRY_TEMPERATURE = 0.15;

async function extractOneChunkWithLlm(
  chunk: SemanticChunk,
  thesis: string,
  memory: ChapterMemory,
  template: string,
  llm: DeltaExtractCallbacks["llm"],
  onEvent?: DeltaExtractCallbacks["onEvent"],
): Promise<ChunkResult> {
  const built = buildPromptWithGuard(template, chunk, thesis, memory);
  const prompt = built.prompt;
  const t0 = Date.now();
  onEvent?.({ type: "delta.chunk.start", chunkPart: chunk.partN, chunkTotal: chunk.partTotal, chapterTitle: chunk.chapterTitle });

  const warnings: string[] = [];
  if (built.truncated) {
    const msg = `chunk-text truncated to ${built.chunkCharsUsed} chars (was ${chunk.text.length}) — long-context guard`;
    warnings.push(msg);
    console.warn(`[delta] chunk ${chunk.partN}: ${msg}`);
  }

  console.log(`[delta] chunk ${chunk.partN}/${chunk.partTotal} "${chunk.chapterTitle}" (${chunk.text.split(/\s+/).length} words)`);
  const first = await tryOneAttempt(prompt, llm, { temperature: 0.3, maxTokens: MAX_TOKENS }, chunk.partN);
  let success = first.ok ? first : null;

  if (!first.ok) {
    console.log(`[delta] chunk ${chunk.partN} attempt-1 FAILED: ${first.reason}`);
    onEvent?.({ type: "delta.retry", chunkPart: chunk.partN, attempt: 2, reason: first.reason });
    warnings.push(`attempt-1: ${first.reason}`);
    const second = await tryOneAttempt(prompt, llm, { temperature: RETRY_TEMPERATURE, maxTokens: MAX_TOKENS * 2 }, chunk.partN);
    if (second.ok) success = second;
    else {
      console.log(`[delta] chunk ${chunk.partN} attempt-2 FAILED: ${second.reason}`);
      warnings.push(`attempt-2: ${second.reason}`);
      onEvent?.({ type: "delta.chunk.error", chunkPart: chunk.partN, error: second.reason });
      onEvent?.({ type: "delta.chunk.done", chunkPart: chunk.partN, chunkTotal: chunk.partTotal, accepted: false, durationMs: Date.now() - t0 });
      return { chunk, delta: null, raw: second.raw || first.raw, warnings };
    }
  }

  const parsed = success!.parsed;

  if (parsed === null || parsed === undefined) {
    onEvent?.({ type: "delta.chunk.skip", chunkPart: chunk.partN, reason: "aura-filter-null" });
    onEvent?.({ type: "delta.chunk.done", chunkPart: chunk.partN, chunkTotal: chunk.partTotal, accepted: false, durationMs: Date.now() - t0 });
    return { chunk, delta: null, raw: success!.raw, warnings };
  }

  const validated = DeltaKnowledgeSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; ");
    console.log(`[delta] chunk ${chunk.partN} ZOD FAIL: ${issues}`);
    warnings.push(`zod: ${issues}`);
    onEvent?.({ type: "delta.chunk.skip", chunkPart: chunk.partN, reason: `zod-fail: ${issues}` });
    onEvent?.({ type: "delta.chunk.done", chunkPart: chunk.partN, chunkTotal: chunk.partTotal, accepted: false, durationMs: Date.now() - t0 });
    return { chunk, delta: null, raw: success!.raw, warnings };
  }

  if (!ALLOWED_DOMAINS.has(validated.data.domain)) {
    console.log(`[delta] chunk ${chunk.partN} UNKNOWN DOMAIN: "${validated.data.domain}"`);
    warnings.push(`unknown-domain: ${validated.data.domain}`);
    onEvent?.({ type: "delta.chunk.skip", chunkPart: chunk.partN, reason: "unknown-domain" });
    onEvent?.({ type: "delta.chunk.done", chunkPart: chunk.partN, chunkTotal: chunk.partTotal, accepted: false, durationMs: Date.now() - t0 });
    return { chunk, delta: null, raw: success!.raw, warnings };
  }

  if (isMetaNoiseDelta(validated.data)) {
    console.log(`[delta] chunk ${chunk.partN} META NOISE: "${validated.data.essence.slice(0, 80)}…"`);
    warnings.push("meta-noise");
    onEvent?.({ type: "delta.chunk.skip", chunkPart: chunk.partN, reason: "meta-noise" });
    onEvent?.({ type: "delta.chunk.done", chunkPart: chunk.partN, chunkTotal: chunk.partTotal, accepted: false, durationMs: Date.now() - t0 });
    return { chunk, delta: null, raw: success!.raw, warnings };
  }

  const delta: DeltaKnowledge = {
    ...validated.data,
    id: makeId(chunk.bookSourcePath, chunk.chapterIndex, chunk.partN, chunk.partTotal, chunk.text),
    bookSourcePath: chunk.bookSourcePath,
    bookTitle: chunk.bookTitle,
    chapterIndex: chunk.chapterIndex,
    acceptedAt: new Date().toISOString(),
  };

  console.log(`[delta] chunk ${chunk.partN} ✓ ACCEPTED domain="${delta.domain}" essence="${delta.essence.slice(0, 60)}…"`);
  onEvent?.({ type: "delta.chunk.done", chunkPart: chunk.partN, chunkTotal: chunk.partTotal, accepted: true, durationMs: Date.now() - t0 });
  return { chunk, delta, raw: success!.raw, warnings };
}

async function extractOneChunk(
  chunk: SemanticChunk,
  thesis: string,
  memory: ChapterMemory,
  template: string,
  cb: DeltaExtractCallbacks,
): Promise<ChunkResult> {
  return extractOneChunkWithLlm(chunk, thesis, memory, template, cb.llm, cb.onEvent);
}

function updateMemory(memory: ChapterMemory, delta: DeltaKnowledge | null): ChapterMemory {
  if (!delta) return memory;
  const ledMerged = [...memory.ledEssences.slice(-4), delta.essence.slice(0, 80)].slice(-5);
  return { ledEssences: ledMerged, lastThesis: memory.lastThesis };
}

/* ─────────────── Public API ─────────────── */

export interface DeltaExtractArgs {
  chunks: SemanticChunk[];
  chapterThesis: string;
  promptsDir?: string | null;
  callbacks: DeltaExtractCallbacks;
  signal?: AbortSignal;
  /**
   * Упорядоченные ключи моделей для cross-model fallback (после same-model
   * double-temperature). Требует `getLlmForModel`; при длине ≤1 не используется.
   */
  extractModelChain?: string[];
  /** LLM для конкретного ключа из `extractModelChain` (delta extraction). */
  getLlmForModel?: (modelKey: string) => DeltaExtractCallbacks["llm"];
}

export interface DeltaExtractResult {
  perChunk: ChunkResult[];
  accepted: DeltaKnowledge[];
  warnings: string[];
}

export async function extractDeltaKnowledge(args: DeltaExtractArgs): Promise<DeltaExtractResult> {
  let template: string;
  try {
    template = await loadPrompt(args.promptsDir ?? null, "delta-knowledge-extractor.md");
  } catch (e) {
    console.error(`[delta-extractor] prompt load failed: ${e instanceof Error ? e.message : e}`);
    return { perChunk: [], accepted: [], warnings: [`prompt-load-failed: ${e instanceof Error ? e.message : e}`] };
  }

  const memory: ChapterMemory = { ledEssences: [], lastThesis: args.chapterThesis };
  const perChunk: ChunkResult[] = [];
  const accepted: DeltaKnowledge[] = [];
  const allWarnings: string[] = [];

  /* Cross-model fallback chain удалён в refactor 1.0.22: одна extractorModel
   * на всё. Если модель плохо справляется — пользователь меняет её через UI. */

  for (const chunk of args.chunks) {
    if (args.signal?.aborted) throw new Error("aborted: delta extraction cancelled");
    const result = await extractOneChunk(chunk, args.chapterThesis, memory, template, args.callbacks);
    perChunk.push(result);
    if (result.delta) accepted.push(result.delta);
    allWarnings.push(...result.warnings.map((w) => `chunk-${chunk.partN}: ${w}`));
    Object.assign(memory, updateMemory(memory, result.delta));
  }

  return { perChunk, accepted, warnings: allWarnings };
}
