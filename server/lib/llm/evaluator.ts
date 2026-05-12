import {
  EVALUATOR_SYSTEM_PROMPT,
  evaluationSchema,
  tryParseEvaluationJson,
  wrapSurrogate,
  type BookEvaluation,
} from "../../../shared/llm/evaluator-schema.js";
import type { ChatRequest, LLMProvider } from "./provider.js";
import { withProvider } from "./model-resolver.js";

/**
 * Server-side Book Evaluator поверх unified LLMProvider interface.
 *
 * Это первый provider-aware consumer (Phase 6c core). Использует
 * withProvider(userId, "evaluator") → resolveForRole читает
 * user_preferences.providerAssignments.evaluator из Phase 6b UI.
 *
 * Отличие от legacy electron/lib/library/book-evaluator.ts:
 *   - НЕТ LM Studio specific reasoning_content path (Anthropic кладёт
 *     thinking в response.reasoning, OpenAI вообще без; clean Provider
 *     intf даёт нам text без CoT).
 *   - НЕТ ModelPool refCount (cloud провайдеры всегда available,
 *     LM Studio через bridge keeps cached client).
 *   - JSON repair retry — ОДИН раз, через тот же provider с strict
 *     "fix JSON" system prompt. Legacy делает retry с другой моделью
 *     pool — здесь упрощено (Phase 6 abstraction не знает про пул).
 *
 * Schema + system prompt — единый источник в /shared/llm/evaluator-schema.ts.
 */

export interface EvaluatorOptions {
  /** Override max tokens (default 4096). Reasoning-models могут требовать больше. */
  maxTokens?: number;
  /** Override temperature (default 0.3 — низко для structured output). */
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Inject provider напрямую — для unit-тестов и dependency injection.
   * Когда задан, withProvider() и user preferences игнорируются.
   */
  providerOverride?: { provider: LLMProvider; model: string };
}

export interface ServerEvaluationResult {
  evaluation: BookEvaluation | null;
  reasoning: string | null;
  raw: string;
  model: string;
  warnings: string[];
}

const REPAIR_SYSTEM_PROMPT =
  "You repair book evaluation output. Return ONLY one strict JSON object " +
  "matching the original schema. No markdown fences, no commentary, no prose.";

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 4096;
const REPAIR_CONTEXT_CHARS = 8000;

/**
 * Single entry point. На входе structural surrogate (от
 * surrogate-builder из ingest pipeline); на выходе validated
 * BookEvaluation или null если LLM не справился даже после repair retry.
 */
export async function evaluateBook(
  userId: string,
  surrogate: string,
  opts: EvaluatorOptions = {},
): Promise<ServerEvaluationResult> {
  if (opts.providerOverride) {
    return evaluateBookWithProvider(
      opts.providerOverride.provider,
      opts.providerOverride.model,
      surrogate,
      opts,
    );
  }
  return withProvider(userId, "evaluator", (provider, model) =>
    evaluateBookWithProvider(provider, model, surrogate, opts),
  );
}

async function evaluateBookWithProvider(
  provider: LLMProvider,
  model: string,
  surrogate: string,
  opts: EvaluatorOptions,
): Promise<ServerEvaluationResult> {
  const warnings: string[] = [];

  const request: ChatRequest = {
    model,
    system: EVALUATOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: wrapSurrogate(surrogate) }],
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
    warnings.push(`evaluator: provider.chat failed: ${msg}`);
    return { evaluation: null, reasoning: null, raw: "", model, warnings };
  }

  const raw = response.text ?? "";
  const reasoning = response.reasoning ?? null;
  const parsed = tryParseEvaluationJson(raw);
  warnings.push(...parsed.warnings);

  if (parsed.json !== null) {
    const validation = evaluationSchema.safeParse(parsed.json);
    if (validation.success) {
      return { evaluation: validation.data, reasoning, raw, model, warnings };
    }
    warnings.push(
      `evaluator: schema mismatch — ${validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    /* Падаем в repair retry с context из bad output. */
  }

  /* Repair retry — один шанс с strict system prompt. */
  return repairAndValidate(provider, model, raw, reasoning, opts, warnings);
}

async function repairAndValidate(
  provider: LLMProvider,
  model: string,
  badRaw: string,
  priorReasoning: string | null,
  opts: EvaluatorOptions,
  warnings: string[],
): Promise<ServerEvaluationResult> {
  warnings.push("evaluator: attempting JSON repair retry");

  const request: ChatRequest = {
    model,
    system: REPAIR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          "Your previous answer was not valid JSON for the required book evaluation schema. " +
          "Do NOT re-analyse the book — just fix the JSON of your prior answer. " +
          "Output ONLY ONE strict JSON object with concrete values (no schema placeholders, " +
          "no markdown, no prose).\n\nPrevious invalid answer:\n" +
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
    warnings.push(`evaluator: repair provider.chat failed: ${msg}`);
    return { evaluation: null, reasoning: priorReasoning, raw: badRaw, model, warnings };
  }

  const rawRepair = response.text ?? "";
  const reasoning = response.reasoning ?? priorReasoning;
  const parsed = tryParseEvaluationJson(rawRepair);
  warnings.push(...parsed.warnings);

  if (parsed.json === null) {
    warnings.push("evaluator: repair retry also failed to produce valid JSON");
    return { evaluation: null, reasoning, raw: rawRepair || badRaw, model, warnings };
  }

  const validation = evaluationSchema.safeParse(parsed.json);
  if (!validation.success) {
    warnings.push(
      `evaluator: repair output also failed schema — ${validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    return { evaluation: null, reasoning, raw: rawRepair, model, warnings };
  }

  return { evaluation: validation.data, reasoning, raw: rawRepair, model, warnings };
}
