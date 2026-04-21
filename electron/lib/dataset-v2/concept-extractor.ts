/**
 * Stage 2 — Concept Extractor (Кристаллизатор) с rolling chapter memory.
 *
 * На каждый чанк главы:
 *   1. Подставляет breadcrumb + chapter memory (1-2 предложения о ранее найденном)
 *   2. Зовёт LLM с жёстким JSON-промптом из concept-extractor.md
 *   3. Валидирует JSON через Zod schema (ExtractedConceptArraySchema)
 *   4. Hallucinated-quote guard: если sourceQuote не в тексте чанка — concept выкидывается
 *   5. Обновляет chapter memory (для следующего чанка той же главы)
 *
 * Между главами memory обнуляется — каждая глава анализируется независимо
 * (book-level cross-chapter dedup делается на Stage 4).
 */

import { promises as fs } from "fs";
import * as path from "path";
import { ExtractedConceptArraySchema, type ChapterMemory, type ExtractedConcept, type SemanticChunk } from "./types.js";
import { ALLOWED_DOMAINS } from "../../mechanicus-prompt.js";

export interface ExtractCallbacks {
  /** Один LLM-call. messages в OpenAI-формате, контракт совместим с lmstudio-client.chat. */
  llm: (args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<string>;
  /** Optional emitter для alchemy log. */
  onEvent?: (e: ExtractEvent) => void;
}

export type ExtractEvent =
  | { type: "extract.chunk.start"; chunkPart: number; chunkTotal: number; chapterTitle: string }
  | { type: "extract.chunk.done"; chunkPart: number; chunkTotal: number; raw: number; valid: number; durationMs: number }
  | { type: "extract.chunk.error"; chunkPart: number; chunkTotal: number; error: string }
  | { type: "extract.parse.warning"; chunkPart: number; reason: string };

interface ChunkResult {
  chunk: SemanticChunk;
  concepts: ExtractedConcept[];
  raw: string;
  warnings: string[];
}

const PROMPT_CACHE: { template: string | null } = { template: null };

/**
 * Несколько кандидатов на расположение bundled defaults — порядок важен.
 * Работает и в CommonJS (Electron prod), и в tsx-ESM (test runner), и в Electron
 * asar-bundle (где `__dirname` указывает в asar:/dist-electron/lib/dataset-v2).
 */
function bundledPromptCandidates(file: string): string[] {
  const candidates: string[] = [];
  if (process.env.BIBLIARY_PROMPTS_DEFAULT_DIR) {
    candidates.push(path.join(process.env.BIBLIARY_PROMPTS_DEFAULT_DIR, file));
  }
  /* CommonJS Electron prod: __dirname доступен (наследуется компилятором) */
  if (typeof __dirname !== "undefined") {
    candidates.push(path.resolve(__dirname, "..", "..", "defaults", "prompts", file));
  }
  /* Source-tree fallback (для tsx-runtime в test/dev): относительно cwd */
  candidates.push(path.resolve(process.cwd(), "electron", "defaults", "prompts", file));
  return candidates;
}

async function loadPromptTemplate(promptsDir: string | null): Promise<string> {
  if (PROMPT_CACHE.template) return PROMPT_CACHE.template;
  if (promptsDir) {
    try {
      const userPath = path.join(promptsDir, "concept-extractor.md");
      const userText = await fs.readFile(userPath, "utf8");
      if (userText.trim().length > 50) {
        PROMPT_CACHE.template = userText;
        return userText;
      }
    } catch {
      /* fallback */
    }
  }
  for (const candidate of bundledPromptCandidates("concept-extractor.md")) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      if (text.trim().length > 50) {
        PROMPT_CACHE.template = text;
        return text;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error("concept-extractor.md not found in any default location");
}

export function clearPromptCache(): void {
  PROMPT_CACHE.template = null;
}

function renderMemoryBlock(memory: ChapterMemory): string {
  if (memory.ledConcepts.length === 0 && !memory.lastSummary) return "";
  const parts = ["Ранее в этой главе автор:"];
  if (memory.ledConcepts.length > 0) parts.push(`- ввёл концепты: ${memory.ledConcepts.join("; ")}`);
  if (memory.lastSummary) parts.push(`- ${memory.lastSummary}`);
  parts.push("Опираясь на это знание, проанализируй следующий отрывок.");
  return parts.join("\n");
}

function buildPrompt(template: string, chunk: SemanticChunk, memory: ChapterMemory): string {
  const allowed = Array.from(ALLOWED_DOMAINS).sort().join(", ");
  return template
    .replace("{{BREADCRUMB}}", chunk.breadcrumb)
    .replace("{{CHAPTER_MEMORY}}", renderMemoryBlock(memory))
    .replace("{{ALLOWED_DOMAINS}}", allowed)
    .replace("{{CHUNK_TEXT}}", chunk.text);
}

function tryParseConceptsJson(raw: string): unknown {
  let cleaned = raw.trim();
  /* Удаляем markdown-fence если модель упорно его добавила */
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  /* Иногда модель добавляет "Here's the JSON:" перед массивом — отрезаем */
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  }
  return JSON.parse(cleaned);
}

function normalizeForQuoteCheck(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function quoteFoundInChunk(quote: string, chunkText: string): boolean {
  const nq = normalizeForQuoteCheck(quote);
  const nt = normalizeForQuoteCheck(chunkText);
  if (nq.length < 12) return false;
  if (nt.includes(nq)) return true;
  /* Эвристика для длинных цитат: первые 60 символов в тексте */
  if (nq.length > 80 && nt.includes(nq.slice(0, 60))) return true;
  return false;
}

async function extractOne(
  chunk: SemanticChunk,
  memory: ChapterMemory,
  template: string,
  cb: ExtractCallbacks
): Promise<ChunkResult> {
  const userPrompt = buildPrompt(template, chunk, memory);
  const t0 = Date.now();
  cb.onEvent?.({
    type: "extract.chunk.start",
    chunkPart: chunk.partN,
    chunkTotal: chunk.partTotal,
    chapterTitle: chunk.chapterTitle,
  });

  let raw: string;
  try {
    raw = await cb.llm({
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.4,
      maxTokens: 4096,
    });
  } catch (e) {
    cb.onEvent?.({
      type: "extract.chunk.error",
      chunkPart: chunk.partN,
      chunkTotal: chunk.partTotal,
      error: e instanceof Error ? e.message : String(e),
    });
    return { chunk, concepts: [], raw: "", warnings: [`llm-error: ${e instanceof Error ? e.message : e}`] };
  }

  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = tryParseConceptsJson(raw);
  } catch (e) {
    warnings.push(`json-parse: ${e instanceof Error ? e.message : e}`);
    cb.onEvent?.({ type: "extract.parse.warning", chunkPart: chunk.partN, reason: "json-parse" });
    cb.onEvent?.({
      type: "extract.chunk.done",
      chunkPart: chunk.partN,
      chunkTotal: chunk.partTotal,
      raw: 0,
      valid: 0,
      durationMs: Date.now() - t0,
    });
    return { chunk, concepts: [], raw, warnings };
  }

  if (!Array.isArray(parsed)) {
    warnings.push(`expected array, got ${typeof parsed}`);
    cb.onEvent?.({
      type: "extract.chunk.done",
      chunkPart: chunk.partN,
      chunkTotal: chunk.partTotal,
      raw: 0,
      valid: 0,
      durationMs: Date.now() - t0,
    });
    return { chunk, concepts: [], raw, warnings };
  }

  const rawCount = parsed.length;

  /* Per-item Zod validation, мягкая (один невалидный не убивает всё) */
  const validated: ExtractedConcept[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    const result = ExtractedConceptArraySchema.element.safeParse(item);
    if (!result.success) {
      warnings.push(`item-${i} invalid: ${result.error.issues.map((x) => x.path.join(".") + ":" + x.message).join("; ")}`);
      continue;
    }
    /* Hallucinated-quote guard */
    if (!quoteFoundInChunk(result.data.sourceQuote, chunk.text)) {
      warnings.push(`item-${i} hallucinated-quote: «${result.data.sourceQuote.slice(0, 60)}…»`);
      continue;
    }
    /* Domain whitelist */
    if (!ALLOWED_DOMAINS.has(result.data.domain)) {
      warnings.push(`item-${i} unknown-domain: ${result.data.domain}`);
      continue;
    }
    validated.push(result.data);
  }

  cb.onEvent?.({
    type: "extract.chunk.done",
    chunkPart: chunk.partN,
    chunkTotal: chunk.partTotal,
    raw: rawCount,
    valid: validated.length,
    durationMs: Date.now() - t0,
  });

  return { chunk, concepts: validated, raw, warnings };
}

function updateMemory(memory: ChapterMemory, concepts: ExtractedConcept[]): ChapterMemory {
  if (concepts.length === 0) return memory;
  const newLed = concepts.slice(0, 4).map((c) => c.principle.slice(0, 60));
  const newSummary = concepts[0].noveltyHint;
  const ledMerged = [...memory.ledConcepts.slice(-3), ...newLed].slice(-6);
  return { ledConcepts: ledMerged, lastSummary: newSummary };
}

export interface ExtractChapterArgs {
  chunks: SemanticChunk[];
  promptsDir?: string | null;
  callbacks: ExtractCallbacks;
}

export interface ExtractChapterResult {
  perChunk: ChunkResult[];
  conceptsTotal: ExtractedConcept[];
  warnings: string[];
}

/**
 * Главная entry-point. Прогон всей главы (все chunks из chunkChapter)
 * с rolling memory. Возвращает плоский список валидных концептов главы
 * + per-chunk детали + список warnings (для UI/CLI отладки).
 */
export async function extractChapterConcepts(args: ExtractChapterArgs): Promise<ExtractChapterResult> {
  const template = await loadPromptTemplate(args.promptsDir ?? null);
  const memory: ChapterMemory = { ledConcepts: [], lastSummary: "" };
  const perChunk: ChunkResult[] = [];
  const conceptsTotal: ExtractedConcept[] = [];
  const allWarnings: string[] = [];

  for (const chunk of args.chunks) {
    const result = await extractOne(chunk, memory, template, args.callbacks);
    perChunk.push(result);
    conceptsTotal.push(...result.concepts);
    allWarnings.push(...result.warnings.map((w) => `chunk-${chunk.partN}: ${w}`));
    /* Update memory только после успешных концептов */
    Object.assign(memory, updateMemory(memory, result.concepts));
  }

  return { perChunk, conceptsTotal, warnings: allWarnings };
}
