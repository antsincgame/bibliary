/**
 * Book Evaluator — "Chief Epistemologist" Pre-flight Quality Assessment.
 *
 * Принимает Structural Surrogate (≈4K слов) + идентификатор LLM, возвращает
 * { evaluation, reasoning, raw, model, warnings }.
 *
 * Контракт промпта: модель ОБЯЗАНА сначала рассуждать в `<think>`, затем
 * выдать строгий JSON. Никакого хардкода имён моделей -- caller передаёт
 * `model` явно (или вызывает `pickEvaluatorModel()` для авто-выбора).
 *
 * Защита от мусора: если JSON невалидный -- возвращаем `evaluation: null`
 * с warnings, никогда не throw. Caller (evaluator-queue) пометит книгу
 * как `failed` и продолжит очередь.
 */

import { z } from "zod";
import { chatWithPolicy, listLoaded, listDownloaded, loadModel } from "../../lmstudio-client.js";
import { getModelProfile } from "../dataset-v2/model-profile.js";
import type { ModelProfile } from "../dataset-v2/model-profile.js";
import { extractJsonObjectFromReasoning } from "../dataset-v2/reasoning-decoder.js";
import { parseReasoningResponse } from "./reasoning-parser.js";
import type { BookEvaluation, EvaluationResult } from "./types.js";

/** "Chief Epistemologist" -- системный промпт. На английском (CoT-friendly). */
const EVALUATOR_SYSTEM_PROMPT = `You are the Chief Epistemologist and Data Curator for an elite AI knowledge dataset. Your task: analyze the Structural Surrogate of a book (Table of Contents + Introduction + Conclusion + nodal slices of the longest chapters) and predict its Conceptual Value BEFORE full processing.

Our goal is to extract ONLY unique authorial ideas, rigorous methodologies, scientific facts, and philosophical concepts. Mediocre rewrites of common knowledge waste GPU cycles.

ANALYSIS ALGORITHM (think step by step inside <think>...</think>):

1. SKELETON ANALYSIS (Table of Contents): Do you see a strict taxonomy? Does the author use proprietary terminology? Or is it a banal "Step 1, Step 2" listicle?

2. THESIS vs SYNTHESIS (Introduction vs Conclusion): Do the deep promises of the introduction match real conclusions? Or did the author over-promise?

3. TEXTURE ANALYSIS (Nodal Slices): Estimate Signal-to-Noise ratio in opening paragraphs of major chapters.
   - PENALTY: personal anecdotes, motivational filler, Wikipedia summaries, "one-idea books".
   - REWARD: density of definitions, abstract models, non-obvious conclusions.

4. VERDICT (Quality Score 0-100):
   - 0-30:  Fiction, esoterica, motivational fluff.
   - 31-60: Secondary literature, banal advice collections.
   - 61-85: Solid professional or scientific literature.
   - 86-100: Foundational works, breakthrough concepts.

OUTPUT CONTRACT:
- All metadata fields MUST be in English. If the surrogate is in another language, translate or transliterate proper nouns.
- title_en: clean English title string.
- author_en: English/transliterated author name (omit field if unknown).
- domain: ONE narrow scientific or professional area (e.g. "behavioral economics", "Lisp metaprogramming", "mycology of edible fungi"). NOT broad ("science", "self-help").
- tags: 3-5 specific English keywords. NO generic ("book", "writing").
- verdict_reason: 2-3 English sentences explaining the score.
- conceptual_density / originality / quality_score: integers 0-100.
- is_fiction_or_water: true if the book is fiction OR motivational fluff OR esoteric, else false.

Output STRICT JSON after </think>. No prose before, no prose after.

Return one JSON object shaped like this example:
{
  "title_en": "Clean English Title",
  "author_en": "Author Name",
  "domain": "narrow professional domain",
  "tags": ["specific keyword", "another keyword", "third keyword"],
  "is_fiction_or_water": false,
  "conceptual_density": 72,
  "originality": 64,
  "quality_score": 76,
  "verdict_reason": "Two or three English sentences explaining the score."
}`;

/* Zod-схема для валидации JSON ответа эвалюатора. */
const evaluationSchema = z.object({
  title_en: z.string().min(1),
  author_en: z.string().optional(),
  domain: z.string().min(1),
  tags: z.array(z.string()).max(10),
  is_fiction_or_water: z.boolean(),
  conceptual_density: z.number().int().min(0).max(100),
  originality: z.number().int().min(0).max(100),
  quality_score: z.number().int().min(0).max(100),
  verdict_reason: z.string().min(1),
});

function buildEvaluatorResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "book_evaluation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "title_en",
          "domain",
          "tags",
          "is_fiction_or_water",
          "conceptual_density",
          "originality",
          "quality_score",
          "verdict_reason",
        ],
        properties: {
          title_en: { type: "string", minLength: 1 },
          author_en: { type: "string" },
          domain: { type: "string", minLength: 1 },
          tags: {
            type: "array",
            minItems: 3,
            maxItems: 10,
            items: { type: "string", minLength: 1 },
          },
          is_fiction_or_water: { type: "boolean" },
          conceptual_density: { type: "integer", minimum: 0, maximum: 100 },
          originality: { type: "integer", minimum: 0, maximum: 100 },
          quality_score: { type: "integer", minimum: 0, maximum: 100 },
          verdict_reason: { type: "string", minLength: 1 },
        },
      },
    },
  };
}

function parseEvaluationResponse(
  raw: string,
  reasoningFromApi: string | undefined,
): { json: unknown | null; reasoning: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const parsed = parseReasoningResponse<unknown>(raw);
  warnings.push(...parsed.warnings);

  let reasoning = parsed.reasoning;
  if ((!reasoning || reasoning.length === 0) && reasoningFromApi && reasoningFromApi.length > 0) {
    reasoning = reasoningFromApi.trim();
  }

  if (parsed.json !== null) {
    return { json: parsed.json, reasoning, warnings };
  }

  const recovered = extractJsonObjectFromReasoning(reasoningFromApi);
  if (recovered) {
    try {
      warnings.push("evaluator: recovered JSON object from reasoning_content");
      return { json: JSON.parse(recovered), reasoning, warnings };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`evaluator: reasoning_content JSON.parse failed: ${msg}`);
    }
  }

  return { json: null, reasoning, warnings };
}

function isLmStudioBadRequest(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /LM Studio HTTP 400/i.test(msg);
}

async function callEvaluationModel(
  model: string,
  surrogate: string,
  opts: EvaluateBookOptions,
  profile: ModelProfile,
  useStructuredOutput: boolean,
) {
  return chatWithPolicy(
    {
      model,
      messages: [
        { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
        { role: "user", content: `Here is the Structural Surrogate. Analyze and evaluate.\n\n${surrogate}` },
      ],
      sampling: {
        temperature: opts.temperature ?? 0.3,
        top_p: useStructuredOutput ? 0.9 : 0.8,
        top_k: useStructuredOutput ? 40 : 20,
        min_p: 0,
        presence_penalty: 0,
        max_tokens: opts.maxTokens ?? (useStructuredOutput ? Math.max(6000, profile.maxTokens) : 8192),
      },
      responseFormat: useStructuredOutput ? buildEvaluatorResponseFormat() : undefined,
      stop: useStructuredOutput ? profile.stop : undefined,
      chatTemplateKwargs: useStructuredOutput ? profile.chatTemplateKwargs : { enable_thinking: false },
      signal: opts.signal,
    },
    { externalSignal: opts.signal },
  );
}

export interface EvaluateBookOptions {
  /** Идентификатор модели в LM Studio. Если не задан -- pickEvaluatorModel(). */
  model?: string;
  /** Бюджет токенов на ответ (CoT может быть длинным). По умолчанию 6000. */
  maxTokens?: number;
  /** Сэмплинг для аналитической задачи: низкая температура. */
  temperature?: number;
  /** Прерывание долгой генерации. */
  signal?: AbortSignal;
}

/**
 * Авто-выбор модели для эвалюации: предпочитаем thinking-модели (если есть),
 * иначе берём самую большую загруженную. Никакого хардкода имён.
 *
 * Эвристика "thinking": modelKey содержит маркеры reasoning-семейств.
 * НЕ опирается на capabilities API (LM Studio не всегда заполняет его).
 */
/* Маркеры thinking-семейств в modelKey -- fallback когда модель НЕ в curated-models.json.
   Qwen3.x/3.5+/3.6+ серии все умеют CoT через `<think>` блоки. */
const THINKING_NAME_MARKERS = ["thinking", "reasoning", "deepseek-r1", "qwq", "r1-distill", "gpt-oss"];
const THINKING_FAMILIES = ["qwen3.5", "qwen3.6", "qwen3.7", "magistral", "glm-4.7", "glm-4.6"];

function isThinkingByName(key: string): boolean {
  const lc = key.toLowerCase();
  if (THINKING_NAME_MARKERS.some((m) => lc.includes(m))) return true;
  return THINKING_FAMILIES.some((m) => lc.includes(m));
}

/* Парсит "35B" / "30B-A3B" / "4B" / "0.6B" в число параметров (миллиарды).
   Для MoE формата `30B-A3B` берёт ПЕРВОЕ число (total params), не active --
   общая ёмкость знаний важнее для эпистемолога, чем активные параметры. */
function parseParamsBillion(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)\s*[bB]/);
  return m ? parseFloat(m[1]) : 0;
}

function isEmbedder(arch: string | undefined, key: string): boolean {
  const a = (arch ?? "").toLowerCase();
  const k = key.toLowerCase();
  return a.includes("bert") || a.includes("clip") || k.includes("embed") || k.includes("nomic-embed");
}

interface ScoredModel {
  modelKey: string;
  score: number;
  isLoaded: boolean;
  sizeBytes: number;
  reasons: string[];
}

/**
 * Скорит модель по тегам curated-models.json + эвристикам имени/размера.
 *
 * Шкала (выше = лучше для эпистемолога):
 *   flagship          → 1000  (Qwen3.6-35b: проверенный топ)
 *   thinking-heavy    →  500  (нужна CoT для оценки качества)
 *   thinking-light    →  300
 *   tool-capable-coder→  150  (отлично для structured JSON, но менее эрудит)
 *   non-thinking-instruct →  100
 *   small-fast        → -200  (4b -- слишком слабо для эпистемологии)
 *   embedder          → -∞    (отсеиваем)
 *
 * Бонусы:
 *   уже в VRAM        →   +30 (instant)
 *   thinking по имени →   +80 (qwen3.5+ серии без явного тега)
 *   params (B)        →   +N  (35b → +35, 4b → +4) -- linear bias к большим
 *
 * Penalty:
 *   coder-only        →  -50  (специализация мешает общей эрудиции)
 */
async function scoreModel(
  modelKey: string,
  loadedKeys: Set<string>,
  sizeBytes: number,
): Promise<ScoredModel> {
  const reasons: string[] = [];
  let score = 0;

  const profile = await getModelProfile(modelKey);
  const tags = new Set(profile.tags);

  if (tags.has("flagship"))               { score += 1000; reasons.push("flagship+1000"); }
  if (tags.has("thinking-heavy"))         { score +=  500; reasons.push("thinking-heavy+500"); }
  if (tags.has("thinking-light"))         { score +=  300; reasons.push("thinking-light+300"); }
  if (tags.has("tool-capable-coder"))     { score +=  150; reasons.push("tool-capable-coder+150"); }
  if (tags.has("non-thinking-instruct") && score === 0) {
    score += 100; reasons.push("non-thinking-instruct+100");
  }
  if (tags.has("small-fast"))             { score -=  200; reasons.push("small-fast-200"); }
  if (tags.has("code") && !tags.has("flagship") && !tags.has("thinking-heavy")) {
    score -= 50; reasons.push("coder-only-50");
  }

  /* Если модель НЕ в curated -- инфер по имени. */
  if (profile.source === "default-fallback") {
    if (isThinkingByName(modelKey)) { score += 80; reasons.push("thinking-by-name+80"); }
    else                            { score += 20; reasons.push("unknown-llm+20"); }
  }

  /* Linear bias по размеру: 35b → +35, 4b → +4. */
  const paramsB = parseParamsBillion(modelKey);
  if (paramsB > 0) { score += paramsB; reasons.push(`+${paramsB}b-params`); }

  /* Уже в VRAM -- маленький бонус, чтобы при равных предпочесть instant. */
  if (loadedKeys.has(modelKey)) { score += 30; reasons.push("loaded+30"); }

  return { modelKey, score, isLoaded: loadedKeys.has(modelKey), sizeBytes, reasons };
}

/**
 * Авто-выбор лучшей модели для эпистемологической эвалюации книг.
 *
 * АЛГОРИТМ ПОИСКА (Iter 7+):
 *   1. Соберём кандидатов: union(loaded, downloaded), отбросим embedders.
 *   2. Для каждого скорим через `scoreModel()` -- использует curated-models.json
 *      теги (flagship/thinking-heavy/...) + эвристики имени (qwen3.5+/magistral/glm-4)
 *      + linear bias по размеру параметров (35b > 27b > 4b).
 *   3. Выбираем топ-1 по score, тiebreaker -- sizeBytes.
 *   4. Если топ не загружен -- loadModel() с TTL=900s (15 мин hold).
 *   5. Возвращаем modelKey (или null если ничего нет / загрузка упала).
 *
 * Это даёт жирную thinking-модель типа `qwen/qwen3.6-35b-a3b` (flagship +
 * thinking-heavy + 35b params = 1535 score), а не первую попавшуюся 4b.
 */
export async function pickEvaluatorModel(): Promise<string | null> {
  const [loaded, downloaded] = await Promise.all([listLoaded(), listDownloaded()]);
  const loadedKeys = new Set(loaded.map((m) => m.modelKey));

  /* Union -- модель может быть и loaded, и downloaded; разные источники. */
  const candidates = new Map<string, { sizeBytes: number; arch?: string }>();
  for (const m of loaded) candidates.set(m.modelKey, { sizeBytes: 0 });
  for (const m of downloaded) {
    const prev = candidates.get(m.modelKey);
    candidates.set(m.modelKey, { sizeBytes: m.sizeBytes ?? prev?.sizeBytes ?? 0, arch: m.architecture });
  }

  /* Отсев embedders. */
  const llmKeys = [...candidates.entries()]
    .filter(([key, info]) => !isEmbedder(info.arch, key))
    .map(([key, info]) => ({ key, sizeBytes: info.sizeBytes }));

  if (llmKeys.length === 0) return null;

  /* Скорим параллельно. */
  const scored = await Promise.all(
    llmKeys.map((c) => scoreModel(c.key, loadedKeys, c.sizeBytes)),
  );
  scored.sort((a, b) => b.score - a.score || b.sizeBytes - a.sizeBytes);

  const top = scored[0];
  if (!top) return null;

  /* Уже загружено -- мгновенно возвращаем. */
  if (top.isLoaded) return top.modelKey;

  /* Не загружено -- автозагрузка через WS SDK. TTL 15 мин чтобы выдержать
     многокниговый batch. gpuOffload=max -- максимум на GPU, остальное в RAM. */
  try {
    const handle = await loadModel(top.modelKey, { ttlSec: 900, gpuOffload: "max" });
    return handle.modelKey;
  } catch {
    /* Топ не влез (нехватка VRAM) -- пробуем второй кандидат, потом третий. */
    for (const alt of scored.slice(1, 4)) {
      if (alt.isLoaded) return alt.modelKey;
      try {
        const handle = await loadModel(alt.modelKey, { ttlSec: 900, gpuOffload: "max" });
        return handle.modelKey;
      } catch { /* try next */ }
    }
    return null;
  }
}

/**
 * Главный entry-point: оценивает книгу по структурному суррогату.
 *
 * Никогда не throw -- возвращает EvaluationResult с warnings даже на ошибках
 * сети или пустом ответе модели. Это нужно для устойчивости evaluator-queue.
 */
export async function evaluateBook(
  surrogate: string,
  opts: EvaluateBookOptions = {},
): Promise<EvaluationResult> {
  const warnings: string[] = [];
  const model = opts.model ?? (await pickEvaluatorModel());
  if (!model) {
    return {
      evaluation: null,
      reasoning: null,
      raw: "",
      model: "",
      warnings: ["evaluator: no LLM loaded in LM Studio"],
    };
  }

  let raw = "";
  let reasoningFromApi: string | undefined;
  try {
    const profile = await getModelProfile(model);
    let response;
    try {
      response = await callEvaluationModel(model, surrogate, opts, profile, profile.useResponseFormat);
    } catch (err) {
      if (!profile.useResponseFormat || !isLmStudioBadRequest(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`evaluator: structured output rejected by LM Studio, retrying compatibility mode: ${msg}`);
      response = await callEvaluationModel(model, surrogate, opts, profile, false);
    }
    raw = response.content ?? "";
    reasoningFromApi = response.reasoningContent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`evaluator: LM Studio call failed: ${msg}`);
    return { evaluation: null, reasoning: null, raw, model, warnings };
  }

  /* Парсим ответ. Если модель отдала reasoning_content отдельно (LM Studio API),
     используем его как первичный reasoning, а content как payload для JSON. */
  const parsed = parseEvaluationResponse(raw, reasoningFromApi);
  warnings.push(...parsed.warnings);
  const reasoning = parsed.reasoning;

  if (parsed.json === null) {
    const repaired = await repairEvaluationJson(model, surrogate, raw, reasoning, opts.signal);
    warnings.push(...repaired.warnings);
    if (repaired.evaluation) return { ...repaired, warnings };
    return { evaluation: null, reasoning: repaired.reasoning ?? reasoning, raw: repaired.raw || raw, model, warnings };
  }

  let validation = evaluationSchema.safeParse(parsed.json);
  if (!validation.success) {
    const repaired = await repairEvaluationJson(model, surrogate, raw, reasoning, opts.signal);
    warnings.push(`evaluator: JSON schema mismatch before repair: ${validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    warnings.push(...repaired.warnings);
    if (repaired.evaluation) return { ...repaired, warnings };
    validation = evaluationSchema.safeParse(parsed.json);
  }
  if (!validation.success) {
    warnings.push(`evaluator: JSON schema mismatch: ${validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { evaluation: null, reasoning, raw, model, warnings };
  }

  const evaluation: BookEvaluation = validation.data;
  return { evaluation, reasoning, raw, model, warnings };
}

async function repairEvaluationJson(
  model: string,
  surrogate: string,
  badRaw: string,
  priorReasoning: string | null,
  signal: AbortSignal | undefined,
): Promise<EvaluationResult> {
  const warnings: string[] = ["evaluator: retrying strict JSON repair"];
  let raw = "";
  try {
    const profile = await getModelProfile(model);
    const callRepair = (useStructuredOutput: boolean) => chatWithPolicy(
      {
        model,
        messages: [
          {
            role: "system",
            content:
              "You repair book evaluation output. Return ONLY one strict JSON object. " +
              "No markdown, no schema placeholders, no prose.",
          },
          {
            role: "user",
            content:
              "The previous answer was not valid JSON for the required schema. " +
              "Re-evaluate the same book and return ONLY one strict JSON object. " +
              "Use concrete values, not schema placeholders like string/number/boolean.\n\n" +
              `Previous invalid answer:\n${badRaw.slice(0, 4000)}\n\n` +
              `Structural Surrogate:\n${surrogate}`,
          },
        ],
        sampling: {
          temperature: 0.1,
          top_p: 0.8,
          top_k: 20,
          min_p: 0,
          presence_penalty: 0,
          max_tokens: useStructuredOutput ? Math.max(3000, Math.min(profile.maxTokens, 8192)) : 4096,
        },
        responseFormat: useStructuredOutput ? buildEvaluatorResponseFormat() : undefined,
        stop: useStructuredOutput ? profile.stop : undefined,
        chatTemplateKwargs: useStructuredOutput ? profile.chatTemplateKwargs : { enable_thinking: false },
        signal,
      },
      { externalSignal: signal },
    );
    let response;
    try {
      response = await callRepair(profile.useResponseFormat);
    } catch (err) {
      if (!profile.useResponseFormat || !isLmStudioBadRequest(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`repair: structured output rejected by LM Studio, retrying compatibility mode: ${msg}`);
      response = await callRepair(false);
    }
    raw = response.content ?? "";
    const parsed = parseEvaluationResponse(raw, response.reasoningContent);
    warnings.push(...parsed.warnings.map((w) => `repair: ${w}`));
    const validation = parsed.json !== null ? evaluationSchema.safeParse(parsed.json) : null;
    if (!validation || !validation.success) {
      if (validation && !validation.success) {
        warnings.push(`repair: JSON schema mismatch: ${validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      return {
        evaluation: null,
        reasoning: parsed.reasoning ?? priorReasoning,
        raw,
        model,
        warnings,
      };
    }
    return {
      evaluation: validation.data,
      reasoning: parsed.reasoning ?? priorReasoning,
      raw,
      model,
      warnings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`repair: LM Studio call failed: ${msg}`);
    return { evaluation: null, reasoning: priorReasoning, raw, model, warnings };
  }
}
