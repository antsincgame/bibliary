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
import { isAbortError } from "../resilience/lm-request-policy.js";
import { extractJsonFromReasoning } from "./reasoning-decoder.js";

/**
 * Результат одного LLM-call. `content` — основное поле OpenAI-compat ответа.
 * `reasoningContent` — поле `reasoning_content` для thinking-моделей; LM Studio
 * часто складывает туда финальный JSON при `response_format=json_schema`,
 * оставляя `content` пустым (см. lmstudio-client.ts + reasoning-decoder.ts).
 *
 * Для backwards-compat callbacks могут возвращать просто string — в этом
 * случае извлечения из reasoning не будет, но старый поток продолжит работать.
 */
export type LlmCallResult = string | { content: string; reasoningContent?: string };

export interface ExtractCallbacks {
  /** Один LLM-call. messages в OpenAI-формате, контракт совместим с lmstudio-client.chat. */
  llm: (args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<LlmCallResult>;
  /** Optional emitter для alchemy log. */
  onEvent?: (e: ExtractEvent) => void;
}

/** Какой prompt-template использовать. mechanicus — для non-thinking/small моделей,
 *  cognitive — для thinking-heavy (Qwen3.6 / DeepSeek-R1) которые ломаются
 *  от unicode-операторов mechanicus-грамматики. */
export type PromptKey = "mechanicus" | "cognitive";

export type ExtractEvent =
  | { type: "extract.chunk.start"; chunkPart: number; chunkTotal: number; chapterTitle: string }
  | { type: "extract.chunk.done"; chunkPart: number; chunkTotal: number; raw: number; valid: number; durationMs: number }
  | { type: "extract.chunk.error"; chunkPart: number; chunkTotal: number; error: string }
  | { type: "extract.parse.warning"; chunkPart: number; reason: string }
  | { type: "extract.retry"; chunkPart: number; attempt: number; reason: string }
  | { type: "extract.reasoning_decoded"; chunkPart: number; chars: number };

interface ChunkResult {
  chunk: SemanticChunk;
  concepts: ExtractedConcept[];
  raw: string;
  warnings: string[];
}

/** Кеш по ключу `${promptsDir||"<bundled>"}:${promptKey}`. Map позволяет
 *  держать ОБА промпта (mechanicus + cognitive) в памяти параллельно — extractor
 *  может переключаться между ними между чанками если в книге смешаны
 *  thinking и non-thinking батчи. */
const PROMPT_CACHE = new Map<string, string>();

const PROMPT_FILES: Record<PromptKey, string> = {
  mechanicus: "concept-extractor-mechanicus.md",
  cognitive: "concept-extractor-cognitive.md",
};

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

async function loadPromptTemplate(promptsDir: string | null, promptKey: PromptKey): Promise<string> {
  const cacheKey = `${promptsDir ?? "<bundled>"}:${promptKey}`;
  const cached = PROMPT_CACHE.get(cacheKey);
  if (cached) return cached;

  const filename = PROMPT_FILES[promptKey];
  if (promptsDir) {
    try {
      const userPath = path.join(promptsDir, filename);
      const userText = await fs.readFile(userPath, "utf8");
      if (userText.trim().length > 50) {
        PROMPT_CACHE.set(cacheKey, userText);
        return userText;
      }
    } catch {
      /* fallback */
    }
  }
  for (const candidate of bundledPromptCandidates(filename)) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      if (text.trim().length > 50) {
        PROMPT_CACHE.set(cacheKey, text);
        return text;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(`${filename} not found in any default location`);
}

export function clearPromptCache(): void {
  PROMPT_CACHE.clear();
}

function renderMemoryBlock(memory: ChapterMemory): string {
  if (memory.ledConcepts.length === 0 && !memory.lastSummary) return "";
  const parts = ["Earlier in this chapter the author has:"];
  if (memory.ledConcepts.length > 0) parts.push(`- introduced concepts: ${memory.ledConcepts.join("; ")}`);
  if (memory.lastSummary) parts.push(`- ${memory.lastSummary}`);
  parts.push("Use this prior knowledge when analysing the next excerpt.");
  return parts.join("\n");
}

/**
 * Контекст из конца предыдущего чанка той же главы. Чанкер уже его генерирует
 * (semantic-chunker.ts:overlapText), но раньше extractor его не использовал —
 * connection-of-thought терялась на стыке чанков. Теперь rendering как явный
 * блок для LLM.
 */
function renderOverlapBlock(chunk: SemanticChunk): string {
  if (!chunk.overlapText || chunk.overlapText.trim().length === 0) return "";
  return `Context from end of previous chunk:\n"${chunk.overlapText.trim()}"\n(This is for continuity only — extract concepts from the new chunk below, not from this overlap.)`;
}

function buildPrompt(template: string, chunk: SemanticChunk, memory: ChapterMemory): string {
  const allowed = Array.from(ALLOWED_DOMAINS).sort().join(", ");
  return template
    .replace("{{BREADCRUMB}}", chunk.breadcrumb)
    .replace("{{CHAPTER_MEMORY}}", renderMemoryBlock(memory))
    .replace("{{OVERLAP_CONTEXT}}", renderOverlapBlock(chunk))
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

/**
 * Нормализует возврат cb.llm к единому формату {content, reasoningContent}.
 * Backwards-compat: если callback вернул просто string — это content.
 */
function normalizeLlmResult(r: LlmCallResult): { content: string; reasoningContent?: string } {
  if (typeof r === "string") return { content: r };
  return { content: r.content ?? "", reasoningContent: r.reasoningContent };
}

/**
 * Попытка одного LLM-call + parse с двумя источниками JSON:
 *   1. content (основной путь)
 *   2. reasoning_content через extractJsonFromReasoning() — спасает thinking-модели
 *      когда LM Studio (баг #1773/#1698/#1602) кладёт JSON в reasoning вместо content.
 *
 * Возвращает либо успешный массив, либо строку с причиной для retry.
 * Не работает с warnings/events — это делает caller (extractOne).
 */
async function tryOneExtractionAttempt(
  userPrompt: string,
  cb: ExtractCallbacks,
  attempt: { temperature: number; maxTokens: number },
  chunkPart: number,
): Promise<{ ok: true; raw: string; parsed: unknown[]; source: "content" | "reasoning" } | { ok: false; raw: string; reason: string }> {
  let lm: { content: string; reasoningContent?: string };
  try {
    lm = normalizeLlmResult(
      await cb.llm({
        messages: [{ role: "user", content: userPrompt }],
        temperature: attempt.temperature,
        maxTokens: attempt.maxTokens,
      }),
    );
  } catch (e) {
    if (isAbortError(e)) throw e;
    return { ok: false, raw: "", reason: `llm-error: ${e instanceof Error ? e.message : e}` };
  }

  const contentTrimmed = lm.content.trim();

  /* Источник 1 — content (основной путь). */
  if (contentTrimmed.length > 0) {
    try {
      const parsed = tryParseConceptsJson(lm.content);
      if (Array.isArray(parsed)) {
        return { ok: true, raw: lm.content, parsed, source: "content" };
      }
      /* parsed не массив — пробуем reasoning ниже как fallback. */
    } catch {
      /* json-parse fail у content — пробуем reasoning ниже как fallback. */
    }
  }

  /* Источник 2 — reasoning_content (fallback для thinking-моделей). */
  const decoded = extractJsonFromReasoning(lm.reasoningContent);
  if (decoded) {
    try {
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) {
        cb.onEvent?.({ type: "extract.reasoning_decoded", chunkPart, chars: decoded.length });
        return { ok: true, raw: decoded, parsed, source: "reasoning" };
      }
      return {
        ok: false,
        raw: decoded,
        reason: `reasoning-decoded but expected array, got ${typeof parsed}`,
      };
    } catch (e) {
      return {
        ok: false,
        raw: decoded,
        reason: `reasoning-decoded but json-parse: ${e instanceof Error ? e.message : e}`,
      };
    }
  }

  /* Оба источника пусты или невалидны — возвращаем понятную причину. */
  if (contentTrimmed.length === 0) {
    return { ok: false, raw: lm.content, reason: "empty-content" };
  }
  return { ok: false, raw: lm.content, reason: "json-parse: invalid in both content and reasoning" };
}

const DEFAULT_EXTRACT_MAX_TOKENS = 8192;
const RETRY_TEMPERATURE = 0.2;

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

  const warnings: string[] = [];

  /* Попытка 1 — нормальные параметры (temperature=0.4 для разнообразия). */
  const first = await tryOneExtractionAttempt(userPrompt, cb, {
    temperature: 0.4,
    maxTokens: DEFAULT_EXTRACT_MAX_TOKENS,
  }, chunk.partN);

  let success: { raw: string; parsed: unknown[] } | null = first.ok ? first : null;

  if (!first.ok) {
    /* Попытка 2 — retry с пониженной температурой и удвоенным budget'ом.
       Низкая температура → меньше "креативного" prose до JSON.
       Удвоенный budget → даёт thinking-моделям шанс долететь до JSON,
       даже если адаптивный профиль уже выставил большой максимум.
       Если retry выпадает по abort (cancel job'а) — пробрасываем как раньше. */
    cb.onEvent?.({
      type: "extract.retry",
      chunkPart: chunk.partN,
      attempt: 2,
      reason: first.reason,
    });
    warnings.push(`attempt-1 failed: ${first.reason}`);
    const second = await tryOneExtractionAttempt(userPrompt, cb, {
      temperature: RETRY_TEMPERATURE,
      maxTokens: DEFAULT_EXTRACT_MAX_TOKENS * 2,
    }, chunk.partN);
    if (second.ok) {
      success = second;
    } else {
      warnings.push(`attempt-2 failed: ${second.reason}`);
      cb.onEvent?.({
        type: first.reason.startsWith("llm-error") ? "extract.chunk.error" : "extract.parse.warning",
        chunkPart: chunk.partN,
        chunkTotal: chunk.partTotal,
        ...(first.reason.startsWith("llm-error")
          ? { error: second.reason }
          : { reason: second.reason }),
      } as ExtractEvent);
      cb.onEvent?.({
        type: "extract.chunk.done",
        chunkPart: chunk.partN,
        chunkTotal: chunk.partTotal,
        raw: 0,
        valid: 0,
        durationMs: Date.now() - t0,
      });
      return { chunk, concepts: [], raw: second.raw || first.raw, warnings };
    }
  }

  /* Здесь success !== null гарантированно — либо first.ok, либо second.ok. */
  const raw = success!.raw;
  const parsed = success!.parsed;
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
  /** Какой prompt использовать. По умолчанию "mechanicus" (точный язык со скрина —
   *  для non-thinking/small моделей). Для thinking-heavy (qwen3.6, deepseek-r1) caller
   *  ОБЯЗАН передать "cognitive" — иначе модель сходит с ума от unicode-операторов. */
  promptKey?: PromptKey;
  callbacks: ExtractCallbacks;
  /** Если signal aborted — выходим между чанками без следующего LLM-call. */
  signal?: AbortSignal;
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
  const template = await loadPromptTemplate(args.promptsDir ?? null, args.promptKey ?? "mechanicus");
  const memory: ChapterMemory = { ledConcepts: [], lastSummary: "" };
  const perChunk: ChunkResult[] = [];
  const conceptsTotal: ExtractedConcept[] = [];
  const allWarnings: string[] = [];

  for (const chunk of args.chunks) {
    if (args.signal?.aborted) {
      throw new Error("aborted: extract cancelled between chunks");
    }
    const result = await extractOne(chunk, memory, template, args.callbacks);
    perChunk.push(result);
    conceptsTotal.push(...result.concepts);
    allWarnings.push(...result.warnings.map((w) => `chunk-${chunk.partN}: ${w}`));
    /* Update memory только после успешных концептов */
    Object.assign(memory, updateMemory(memory, result.concepts));
  }

  return { perChunk, conceptsTotal, warnings: allWarnings };
}
