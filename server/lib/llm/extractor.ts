import {
  EXTRACTOR_SYSTEM_PROMPT,
  DeltaKnowledgeSchema,
  buildExtractorMessages,
  tryParseDeltaJson,
  type DeltaKnowledge,
  type ExtractorInputChunk,
  type ExtractorInputContext,
} from "../../../shared/llm/extractor-schema.js";
import type { ChatRequest, LLMProvider } from "./provider.js";
import { withProvider } from "./model-resolver.js";

/**
 * Single-chunk delta-knowledge extractor поверх LLMProvider abstraction.
 *
 * Per `.claude/rules/02-extraction.md`:
 *   - thinking-модели приоритетны (Anthropic claude-opus/sonnet/haiku
 *     с extended_thinking, OpenAI o1/o3, LM Studio Qwen3-Reasoning).
 *   - promptCache=true — главное условие cost-эффективности при
 *     прогоне 100+ глав одной книги (system prompt + chapter context
 *     повторяются).
 *
 * Возвращает либо DeltaKnowledge либо null (модель явно сказала «filler»
 * либо JSON не парсится после retry).
 */

export interface ExtractorOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** DI для unit-тестов — обходит withProvider/preferences. */
  providerOverride?: { provider: LLMProvider; model: string };
}

export interface ExtractorResult {
  delta: DeltaKnowledge | null;
  /** Causes for null delta: "filler" (explicit null), "parse_failed", "schema_failed", "provider_error". */
  rejectReason?: "filler" | "parse_failed" | "schema_failed" | "provider_error";
  raw: string;
  reasoning: string | null;
  model: string;
  warnings: string[];
}

const REPAIR_SYSTEM_PROMPT =
  "You repair delta-knowledge extraction output. Return ONLY one strict JSON object " +
  "matching the schema, OR the literal string null. No markdown, no commentary.";

const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_MAX_TOKENS = 2048;
const REPAIR_CONTEXT_CHARS = 4000;

export async function extractDeltaForChunk(
  userId: string,
  chunk: ExtractorInputChunk,
  ctx: ExtractorInputContext,
  opts: ExtractorOptions = {},
): Promise<ExtractorResult> {
  if (opts.providerOverride) {
    return extractWithProvider(
      opts.providerOverride.provider,
      opts.providerOverride.model,
      chunk,
      ctx,
      opts,
    );
  }
  return withProvider(userId, "crystallizer", (provider, model) =>
    extractWithProvider(provider, model, chunk, ctx, opts),
  );
}

async function extractWithProvider(
  provider: LLMProvider,
  model: string,
  chunk: ExtractorInputChunk,
  ctx: ExtractorInputContext,
  opts: ExtractorOptions,
): Promise<ExtractorResult> {
  const warnings: string[] = [];
  const request: ChatRequest = {
    model,
    system: EXTRACTOR_SYSTEM_PROMPT,
    messages: buildExtractorMessages(chunk, ctx),
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    responseFormat: "json_object",
    promptCache: true,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  let response;
  try {
    response = await provider.chat(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`extractor: provider.chat failed: ${msg}`);
    return {
      delta: null,
      rejectReason: "provider_error",
      raw: "",
      reasoning: null,
      model,
      warnings,
    };
  }

  const raw = response.text ?? "";
  const reasoning = response.reasoning ?? null;
  const parsed = tryParseDeltaJson(raw);
  warnings.push(...parsed.warnings);

  if (parsed.isExplicitNull) {
    return {
      delta: null,
      rejectReason: "filler",
      raw,
      reasoning,
      model,
      warnings,
    };
  }

  if (parsed.json !== null) {
    const validation = DeltaKnowledgeSchema.safeParse(parsed.json);
    if (validation.success) {
      return { delta: validation.data, raw, reasoning, model, warnings };
    }
    warnings.push(
      `extractor: schema mismatch — ${validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return repairAndValidate(provider, model, raw, reasoning, opts, warnings);
}

async function repairAndValidate(
  provider: LLMProvider,
  model: string,
  badRaw: string,
  priorReasoning: string | null,
  opts: ExtractorOptions,
  warnings: string[],
): Promise<ExtractorResult> {
  warnings.push("extractor: attempting JSON repair retry");

  const request: ChatRequest = {
    model,
    system: REPAIR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          "Your previous answer was not valid JSON for the delta-knowledge schema. " +
          "Do NOT re-extract — fix the JSON of your prior answer (or output null if no delta). " +
          "Output ONLY one strict JSON object with concrete values, OR the literal string null.\n\n" +
          "Previous invalid answer:\n" +
          badRaw.slice(0, REPAIR_CONTEXT_CHARS),
      },
    ],
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: 0,
    responseFormat: "json_object",
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  let response;
  try {
    response = await provider.chat(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`extractor: repair provider.chat failed: ${msg}`);
    return {
      delta: null,
      rejectReason: "provider_error",
      raw: badRaw,
      reasoning: priorReasoning,
      model,
      warnings,
    };
  }

  const rawRepair = response.text ?? "";
  const reasoning = response.reasoning ?? priorReasoning;
  const parsed = tryParseDeltaJson(rawRepair);
  warnings.push(...parsed.warnings);

  if (parsed.isExplicitNull) {
    return {
      delta: null,
      rejectReason: "filler",
      raw: rawRepair,
      reasoning,
      model,
      warnings,
    };
  }
  if (parsed.json === null) {
    warnings.push("extractor: repair retry also failed to produce valid JSON");
    return {
      delta: null,
      rejectReason: "parse_failed",
      raw: rawRepair || badRaw,
      reasoning,
      model,
      warnings,
    };
  }

  const validation = DeltaKnowledgeSchema.safeParse(parsed.json);
  if (!validation.success) {
    warnings.push(
      `extractor: repair output also failed schema — ${validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    return {
      delta: null,
      rejectReason: "schema_failed",
      raw: rawRepair,
      reasoning,
      model,
      warnings,
    };
  }
  return { delta: validation.data, raw: rawRepair, reasoning, model, warnings };
}

/**
 * Multi-chunk pipeline для всей главы. Возвращает accepted deltas +
 * статистику. Удерживает ChapterMemory ledger (последние 5 essences)
 * для continuity context.
 *
 * Per-chunk failures isolated — одна ошибка не блокирует следующие.
 * Caller (extraction-runner для книги) собирает results по главам.
 */
export interface ChapterExtractionInput {
  chapterThesis: string;
  chunks: ExtractorInputChunk[];
}

export interface ChapterExtractionResult {
  perChunk: ExtractorResult[];
  accepted: DeltaKnowledge[];
  warnings: string[];
  /** Counts: extracted / filler / failed / total. */
  stats: {
    total: number;
    extracted: number;
    filler: number;
    failed: number;
  };
}

const LEDGER_SIZE = 5;
const ESSENCE_TRUNCATE = 80;

export async function extractChapter(
  userId: string,
  chapter: ChapterExtractionInput,
  opts: ExtractorOptions = {},
): Promise<ChapterExtractionResult> {
  const perChunk: ExtractorResult[] = [];
  const accepted: DeltaKnowledge[] = [];
  const allWarnings: string[] = [];
  const ledEssences: string[] = [];
  let extracted = 0;
  let filler = 0;
  let failed = 0;

  for (const chunk of chapter.chunks) {
    if (opts.signal?.aborted) break;
    const result = await extractDeltaForChunk(
      userId,
      chunk,
      { chapterThesis: chapter.chapterThesis, ledEssences: [...ledEssences] },
      opts,
    );
    perChunk.push(result);
    allWarnings.push(...result.warnings.map((w) => `chunk-${chunk.partN}: ${w}`));
    if (result.delta) {
      accepted.push(result.delta);
      extracted += 1;
      ledEssences.push(result.delta.essence.slice(0, ESSENCE_TRUNCATE));
      if (ledEssences.length > LEDGER_SIZE) ledEssences.shift();
    } else if (result.rejectReason === "filler") {
      filler += 1;
    } else {
      failed += 1;
    }
  }

  return {
    perChunk,
    accepted,
    warnings: allWarnings,
    stats: {
      total: chapter.chunks.length,
      extracted,
      filler,
      failed,
    },
  };
}
