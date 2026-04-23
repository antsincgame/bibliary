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
import { chatWithPolicy, listLoaded } from "../../lmstudio-client.js";
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
- title_en: clean English title (no quotes around it).
- author_en: English/transliterated author name (omit field if unknown).
- domain: ONE narrow scientific or professional area (e.g. "behavioral economics", "Lisp metaprogramming", "mycology of edible fungi"). NOT broad ("science", "self-help").
- tags: 3-5 specific English keywords. NO generic ("book", "writing").
- verdict_reason: 2-3 English sentences explaining the score.
- conceptual_density / originality / quality_score: integers 0-100.
- is_fiction_or_water: true if the book is fiction OR motivational fluff OR esoteric, else false.

Output STRICT JSON after </think>. No prose before, no prose after.

JSON SCHEMA:
{
  "title_en": string,
  "author_en"?: string,
  "domain": string,
  "tags": string[],
  "is_fiction_or_water": boolean,
  "conceptual_density": number,
  "originality": number,
  "quality_score": number,
  "verdict_reason": string
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
const THINKING_MARKERS = ["thinking", "reasoning", "deepseek-r1", "qwq", "r1-distill", "gpt-oss"];

export async function pickEvaluatorModel(): Promise<string | null> {
  const loaded = await listLoaded();
  if (loaded.length === 0) return null;
  /* Предпочитаем уже загруженную thinking-модель. */
  const thinking = loaded.find((m) => {
    const lc = m.modelKey.toLowerCase();
    return THINKING_MARKERS.some((mark) => lc.includes(mark));
  });
  if (thinking) return thinking.modelKey;
  /* Иначе берём самую большую (по contextLength как прокси для размера). */
  const sorted = [...loaded].sort((a, b) => (b.contextLength ?? 0) - (a.contextLength ?? 0));
  return sorted[0]?.modelKey ?? null;
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
    const response = await chatWithPolicy(
      {
        model,
        messages: [
          { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
          { role: "user", content: `Here is the Structural Surrogate. Analyze and evaluate.\n\n${surrogate}` },
        ],
        sampling: {
          temperature: opts.temperature ?? 0.3,
          top_p: 0.9,
          top_k: 40,
          min_p: 0,
          presence_penalty: 0,
          max_tokens: opts.maxTokens ?? 6000,
        },
        signal: opts.signal,
      },
      { externalSignal: opts.signal },
    );
    raw = response.content ?? "";
    reasoningFromApi = response.reasoningContent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`evaluator: LM Studio call failed: ${msg}`);
    return { evaluation: null, reasoning: null, raw, model, warnings };
  }

  /* Парсим ответ. Если модель отдала reasoning_content отдельно (LM Studio API),
     используем его как первичный reasoning, а content как payload для JSON. */
  const parsed = parseReasoningResponse<unknown>(raw);
  warnings.push(...parsed.warnings);

  /* Если API дала reasoning отдельно -- предпочитаем её (она надёжнее, не зависит
     от того, написала ли модель `<think>` явно). Парсер уже отработал по content,
     но reasoning из inline `<think>` может быть пустым -- тогда падаем на API. */
  let reasoning = parsed.reasoning;
  if ((!reasoning || reasoning.length === 0) && reasoningFromApi && reasoningFromApi.length > 0) {
    reasoning = reasoningFromApi.trim();
  }

  if (parsed.json === null) {
    return { evaluation: null, reasoning, raw, model, warnings };
  }

  const validation = evaluationSchema.safeParse(parsed.json);
  if (!validation.success) {
    warnings.push(`evaluator: JSON schema mismatch: ${validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { evaluation: null, reasoning, raw, model, warnings };
  }

  const evaluation: BookEvaluation = validation.data;
  return { evaluation, reasoning, raw, model, warnings };
}
