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
 *
 * Декомпозиция (Phase 2.3 cross-platform roadmap, 2026-04-30):
 *   - Zod schema, response-format и парсинг → `book-evaluator-schema.ts`
 *   - Auto-выбор модели (scoring + heuristics) → `book-evaluator-model-picker.ts`
 *   - В этом файле: промпт, `evaluateBook`, `repairEvaluationJson` + barrel
 *     re-export `pickEvaluatorModel` для backward compat.
 */

import { chatWithPolicy } from "../../lmstudio-client.js";
import { getModelProfile } from "../dataset-v2/model-profile.js";
import type { ModelProfile } from "../dataset-v2/model-profile.js";
import type { BookEvaluation, EvaluationResult } from "./types.js";
import { getModelPool, type ModelPool } from "../llm/model-pool.js";
import {
  evaluationSchema,
  buildEvaluatorResponseFormat,
  parseEvaluationResponse,
  isLmStudioBadRequest,
} from "./book-evaluator-schema.js";

/* Re-export для backward compat — потребители `book-evaluator` всё ещё
   импортят `pickEvaluatorModel` оттуда. */
export {
  pickEvaluatorModel,
  type PickEvaluatorModelOptions,
} from "./book-evaluator-model-picker.js";
import { pickEvaluatorModel } from "./book-evaluator-model-picker.js";

/** Sampling/токен-бюджеты для evaluator inference. Вынесены из inline-литералов
 *  в Block A1 (zero behavioral change). */
const EVALUATOR_INFERENCE = {
  defaultTemperature: 0.3,
  /** top_p при structured output (response_format) — больше разнообразия. */
  structuredTopP: 0.9,
  /** top_p при compatibility mode (без response_format). */
  compatibilityTopP: 0.8,
  structuredTopK: 40,
  compatibilityTopK: 20,
  minP: 0,
  presencePenalty: 0,
  /** Минимум max_tokens при structured output. */
  structuredMinMaxTokens: 6000,
  /** max_tokens при compatibility mode (без response_format). */
  compatibilityMaxTokens: 8192,
  /** Repair pass: минимум max_tokens при structured output. */
  repairStructuredMinMaxTokens: 3000,
  /** Repair pass: верхняя граница max_tokens при structured output. */
  repairStructuredMaxTokens: 8192,
  /** Repair pass: max_tokens в compatibility mode. */
  repairCompatibilityMaxTokens: 4096,
  repairTemperature: 0.1,
  /** Сколько символов из предыдущего ответа отдаём в repair-prompt. */
  repairContextChars: 4000,
} as const;

/** "Chief Epistemologist" -- системный промпт. На английском (CoT-friendly). */
const EVALUATOR_SYSTEM_PROMPT = `You are the Chief Epistemologist, Bibliographic Detective, and Data Curator for an elite AI knowledge dataset. Your task: analyze the Structural Surrogate of a book (delivered inside <document> tags in the user message) and extract MAXIMUM bibliographic metadata + predict Conceptual Value.

CRITICAL MISSION — METADATA EXTRACTION:
You MUST treat every book as a forensic investigation. Scan EVERY section for clues:
- METADATA ZONE: title page lines, colophon, copyright notices, ISBN. Author name and year are almost ALWAYS here.
- INTRODUCTION/PREFACE: authors often introduce themselves ("I, John Smith, have spent 20 years..."), mention publication context ("this 2003 edition...").
- CONCLUSION/AFTERWORD: acknowledgments often reveal author identity.
- TABLE OF CONTENTS: may contain author name in chapter attributions.
- EMBEDDED CITATIONS: references like "(Smith, 2019)" reveal both author and year.
- COPYRIGHT LINES: "© 2015 John Doe" — this is gold.
- ISBN LINES: year is encoded in ISBNs published after 2007.

AUTHOR EXTRACTION RULES (MANDATORY):
- Scan the Metadata Zone FIRST. Look for patterns: "Author:", "By:", "Автор:", names after "©", names on title page lines.
- For Cyrillic scripts (Russian, Ukrainian, Bulgarian, Serbian, Macedonian), transliterate to Latin (e.g. "Іваненко П.К." → "Ivanenko P.K.", "Иванов В.В." → "Ivanov V.V.").
- Ukrainian markers: і, ї, є, ґ. Don't confuse with Russian — these are different languages.
- If multiple authors, list the primary one (or "First Author et al.").
- "Unknown" is ONLY acceptable if you have exhaustively searched ALL sections and found ZERO authorship clues. Explain in verdict_reason WHY you could not find the author.

YEAR EXTRACTION RULES (MANDATORY):
- Look for 4-digit years (1400-2026) near: "©", "copyright", "published", "edition", "ISBN".
- Russian markers: "год издания", "издательство", "г." after the year.
- Ukrainian markers: "рік видання", "видавництво", "р." after the year, "накладом".
- If multiple years found, pick the PUBLICATION year (not reprint, not citation year).
- null is ONLY acceptable if NO year pattern exists anywhere in the surrogate. This is rare — most books have at least a copyright year.

BOOK TYPE AWARENESS:
- Scientific monograph / textbook: deep domain knowledge, formal structure → high conceptual_density if content is substantial.
- Popular non-fiction / advice book: readable but shallow → 31-60 range; is_fiction_or_water stays false.
- Fiction / motivational / esoteric: is_fiction_or_water = true → quality_score 0-30 regardless of writing quality.
- Anthology / collected papers: each chapter may have a different author → use editor name + "ed." in author fields.
- Translation: note the original language in verdict_reason; author_en should be original author, not translator.

QUALITY ANALYSIS (think step by step inside <think>...</think>):

1. BIBLIOGRAPHIC FORENSICS: List every author/year/publisher clue you found. Quote the exact line.
2. SKELETON ANALYSIS (TOC): strict taxonomy? proprietary terminology? or banal listicle?
3. THESIS vs SYNTHESIS: do introduction promises match conclusion deliveries?
4. TEXTURE ANALYSIS (Nodal Slices): Signal-to-Noise ratio.
   PENALTY: anecdotes, motivational filler, Wikipedia rewrites.
   REWARD: definitions, abstract models, non-obvious conclusions.
5. DOMAIN CLASSIFICATION: pick ONE narrow area. NOT broad ("science", "psychology", "programming"). BE SPECIFIC:
   - For CS/tech: "C++ programming language", "Qt framework development", "Python data science", "compiler design", "network programming", "assembly language programming", "object-oriented design patterns"
   - For math/science: "finite element analysis", "functional analysis", "mycology of edible fungi"
   - For humanities: "cognitive load theory", "behavioral economics", "stoic philosophy"
6. TAG GENERATION: produce 8-12 tags in BOTH languages:
   - tags: English — subject area, methodology, audience, era, key concepts, application domain.
   - tags_ru: Russian — same coverage (not a pedantic literal translation; natural Russian scholarly phrasing).

VERDICT (Quality Score 0-100):
  0-30:  Fiction, esoterica, motivational fluff.
  31-60: Secondary literature, banal advice collections.
  61-85: Solid professional or scientific literature.
  86-100: Foundational works, breakthrough concepts.

OUTPUT CONTRACT:
- Bibliographic mirrors in TWO languages (same work, canonical spelling each language):
  - title_ru / author_ru: Russian (Cyrillic). If the book is not Russian, translate or use conventional Russian bibliographic form.
  - title_en / author_en: English. Transliterate Cyrillic authors to Latin (e.g. "Иванов В.В." → "Ivanov V.V.").
- domain, verdict_reason: English (dataset / search consistency).
- tags: 8-12 specific English keywords. NO generic words ("book", "science", "writing").
- tags_ru: 8-12 Russian keywords — same themes and granularity as English tags (count must match).
- author_ru and author_en: REQUIRED unless truly unknowable — then "Unknown" with explanation in verdict_reason.
- year: integer publication year. null only if truly absent from all sections.
- domain: ONE narrow domain in English (e.g. "behavioral economics", "Oberon compiler design").
- verdict_reason: 2-3 sentences. If author="Unknown" or year=null, EXPLAIN what you searched and why you failed.
- conceptual_density / originality / quality_score: integers 0-100.
- is_fiction_or_water: true for fiction / motivational / esoteric, else false.

Output STRICT JSON after </think>.

━━━ FEW-SHOT EXAMPLES ━━━

Example 1 — Ukrainian technical monograph (high score):
<surrogate>
[METADATA] Іваненко П.К. — Методи скінченних елементів. © 2011 Видавництво «Наукова думка», Київ. ISBN 978-966-00-1174-3
[TOC] Розділ 1. Основи варіаційного числення. Розділ 2. Дискретизація. Розділ 3. Збіжність. Розділ 4. Застосування в механіці суцільних середовищ.
[INTRO] ...у монографії систематично викладено сучасну теорію МСЕ...
[NODAL] ...похибка апроксимації зменшується як O(h²) при рівномірному розбитті...
</surrogate>

Expected output (abbreviated):
{"title_ru":"Методы конечных элементов","author_ru":"Иваненко П.К.","title_en":"Finite Element Methods","author_en":"Ivanenko P.K.","year":2011,"domain":"finite element analysis","tags":["finite element method","numerical methods","variational calculus","continuum mechanics","convergence analysis","discretization","Ukrainian mathematics","engineering simulation"],"tags_ru":["метод скінченних елементів","чисельні методи","варіаційне числення","механіка суцільних середовищ","аналіз збіжності","дискретизація","українська математика","інженерне моделювання"],"is_fiction_or_water":false,"conceptual_density":88,"originality":72,"quality_score":84,"verdict_reason":"Rigorous Ukrainian monograph on FEM with formal convergence proofs and continuum mechanics applications. Dense theoretical content with non-obvious results. Authorship and date confirmed from colophon."}

Example 2 — Motivational self-help (low score):
<surrogate>
[METADATA] John Maxwell — Think and Grow Rich: 21 Laws of Success. © 2019 HarperCollins.
[TOC] Chapter 1: Believe in Yourself. Chapter 2: Visualize Victory. Chapter 3: Never Give Up. Chapter 4: Surround Yourself with Winners.
[INTRO] ...I want to help you unlock your inner potential and achieve greatness...
[NODAL] ...Success is not a destination, it's a journey. Every morning I wake up and choose success...
</surrogate>

Expected output (abbreviated):
{"title_ru":"Думай и богатей: 21 закон успеха","author_ru":"Максвелл Дж.","title_en":"Think and Grow Rich: 21 Laws of Success","author_en":"Maxwell J.","year":2019,"domain":"motivational self-help","tags":["self-help","motivation","success mindset","personal development","leadership","positive thinking","business advice","bestseller"],"tags_ru":["саморазвитие","мотивация","установка на успех","личностный рост","лидерство","позитивное мышление","деловые советы","бестселлер"],"is_fiction_or_water":true,"conceptual_density":8,"originality":12,"quality_score":15,"verdict_reason":"Generic motivational self-help with anecdotal advice and no original research. Banal chapter structure. is_fiction_or_water=true due to lack of substantive content."}

Example 3 — Programming textbook (specific domain, NOT generic "programming"):
<surrogate>
[METADATA] Bjarne Stroustrup — The C++ Programming Language. 4th Edition. © 2013 Addison-Wesley Professional. ISBN 978-0-321-56384-2
[TOC] Part I: Introduction. Part II: Basic Facilities — Types, Pointers, Arrays. Part III: Abstraction Mechanisms — Classes, Templates, Move Semantics. Part IV: Standard Library — STL, Algorithms, Concurrency.
[INTRO] ...C++ is a general-purpose programming language with a bias toward systems programming...
[NODAL] ...Rvalue references enable move semantics, eliminating unnecessary copies. A concept constrains template arguments at compile time...
</surrogate>

Expected output (abbreviated):
{"title_ru":"Язык программирования C++. 4-е издание","author_ru":"Страуструп Б.","title_en":"The C++ Programming Language. 4th Edition","author_en":"Stroustrup B.","year":2013,"domain":"C++ programming language","tags":["C++","systems programming","object-oriented programming","templates","move semantics","STL","concurrency","type system"],"tags_ru":["C++","системное программирование","объектно-ориентированное программирование","шаблоны","семантика перемещения","STL","конкурентность","система типов"],"is_fiction_or_water":false,"conceptual_density":82,"originality":76,"quality_score":90,"verdict_reason":"Definitive reference for the C++ language by its creator. Covers language semantics, type system, templates, and standard library with rigorous technical depth. Essential for professional C++ developers."}

━━━ END EXAMPLES ━━━`;

/** Обёртка вокруг surrogate — помогает модели чётко отделить инструкции от данных. */
function wrapSurrogate(surrogate: string): string {
  return `Here is the Structural Surrogate. Analyze and evaluate.\n\n<document type="structural-surrogate">\n${surrogate}\n</document>`;
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
        { role: "user", content: wrapSurrogate(surrogate) },
      ],
      sampling: {
        temperature: opts.temperature ?? EVALUATOR_INFERENCE.defaultTemperature,
        top_p: useStructuredOutput ? EVALUATOR_INFERENCE.structuredTopP : EVALUATOR_INFERENCE.compatibilityTopP,
        top_k: useStructuredOutput ? EVALUATOR_INFERENCE.structuredTopK : EVALUATOR_INFERENCE.compatibilityTopK,
        min_p: EVALUATOR_INFERENCE.minP,
        presence_penalty: EVALUATOR_INFERENCE.presencePenalty,
        max_tokens: opts.maxTokens ?? (
          useStructuredOutput
            ? Math.max(EVALUATOR_INFERENCE.structuredMinMaxTokens, profile.maxTokens)
            : EVALUATOR_INFERENCE.compatibilityMaxTokens
        ),
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
  /** DI hook для тестов — подменить ModelPool. Дефолт — `getModelPool()` singleton. */
  pool?: ModelPool;
}

/**
 * Главный entry-point: оценивает книгу по структурному суррогату.
 *
 * Не бросает наружу: сбои LM (сеть, HTTP, таймаут после ретраев `chatWithPolicy`),
 * пустой/битый ответ, ошибки repair — всё уходит в `warnings` и `evaluation: null`.
 * Внешний try/catch ниже ловит всё, что выбрасывают `getModelProfile` / `callEvaluationModel`
 * / вложенные пути, чтобы очередь не падала на одной книге.
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

  /* Audit fix 2026-04-30: pool.withModel удерживает refCount > 0 на всё
     время inference + repair. Без этого ModelPool мог выбрать evaluator
     модель как LRU-жертву (refCount=0) и выгрузить её посреди chat —
     LM Studio вернул бы ошибку «model not loaded» через 30+ сек таймаута. */
  const pool = opts.pool ?? getModelPool();
  return pool.withModel(
    model,
    { role: "evaluator", ttlSec: 1800, gpuOffload: "max" },
    async () => {
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
        /* Не только «сеть»: сюда же попадают HTTP-ошибки, исчерпание ретраев, сбой профиля и т.д. */
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
        const repaired = await repairEvaluationJson(model, raw, reasoning, opts.signal);
        warnings.push(...repaired.warnings);
        if (repaired.evaluation) return { ...repaired, warnings };
        return { evaluation: null, reasoning: repaired.reasoning ?? reasoning, raw: repaired.raw || raw, model, warnings };
      }

      let validation = evaluationSchema.safeParse(parsed.json);
      if (!validation.success) {
        const repaired = await repairEvaluationJson(model, raw, reasoning, opts.signal);
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
    },
  );
}

async function repairEvaluationJson(
  model: string,
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
              "Your previous answer was not valid JSON for the required schema. " +
              "DO NOT re-evaluate the book — just fix the JSON of your previous answer. " +
              "Output ONLY one strict JSON object with concrete values (no schema placeholders like string/number/boolean, no markdown, no prose).\n\n" +
              `Previous invalid answer to fix:\n${badRaw.slice(0, EVALUATOR_INFERENCE.repairContextChars)}`,
          },
        ],
        sampling: {
          temperature: EVALUATOR_INFERENCE.repairTemperature,
          top_p: EVALUATOR_INFERENCE.compatibilityTopP,
          top_k: EVALUATOR_INFERENCE.compatibilityTopK,
          min_p: EVALUATOR_INFERENCE.minP,
          presence_penalty: EVALUATOR_INFERENCE.presencePenalty,
          max_tokens: useStructuredOutput
            ? Math.max(
                EVALUATOR_INFERENCE.repairStructuredMinMaxTokens,
                Math.min(profile.maxTokens, EVALUATOR_INFERENCE.repairStructuredMaxTokens),
              )
            : EVALUATOR_INFERENCE.repairCompatibilityMaxTokens,
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
