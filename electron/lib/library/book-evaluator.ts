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
5. DOMAIN CLASSIFICATION: pick ONE narrow area. NOT broad ("science", "psychology"). BE SPECIFIC ("cognitive load theory", "finite element analysis", "mycology of edible fungi").
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

━━━ END EXAMPLES ━━━`;

/** Обёртка вокруг surrogate — помогает модели чётко отделить инструкции от данных. */
function wrapSurrogate(surrogate: string): string {
  return `Here is the Structural Surrogate. Analyze and evaluate.\n\n<document type="structural-surrogate">\n${surrogate}\n</document>`;
}

/* Zod-схема для валидации JSON ответа эвалюатора. */
const evaluationSchema = z.object({
  title_ru: z.string().min(1),
  author_ru: z.string().min(1),
  title_en: z.string().min(1),
  author_en: z.string().min(1),
  year: z.number().int().min(1400).max(2100).nullable(),
  domain: z.string().min(1),
  tags: z.array(z.string()).min(8).max(12),
  tags_ru: z.array(z.string()).min(8).max(12),
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
          "title_ru",
          "author_ru",
          "title_en",
          "author_en",
          "year",
          "domain",
          "tags",
          "tags_ru",
          "is_fiction_or_water",
          "conceptual_density",
          "originality",
          "quality_score",
          "verdict_reason",
        ],
        properties: {
          title_ru: { type: "string", minLength: 1 },
          author_ru: { type: "string", minLength: 1 },
          title_en: { type: "string", minLength: 1 },
          author_en: { type: "string", minLength: 1 },
          year: { anyOf: [{ type: "integer", minimum: 1400, maximum: 2100 }, { type: "null" }] },
          domain: { type: "string", minLength: 1 },
          tags: {
            type: "array",
            minItems: 8,
            maxItems: 12,
            items: { type: "string", minLength: 1 },
          },
          tags_ru: {
            type: "array",
            minItems: 8,
            maxItems: 12,
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
        { role: "user", content: wrapSurrogate(surrogate) },
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
 * Опции выбора модели для evaluator.
 *
 * `preferred` и `fallbacks` приходят из preferences (Settings → Models →
 * Evaluator + CSV fallbacks). Когда юзер выбрал конкретную модель, мы ОБЯЗАНЫ
 * её использовать, не подменяя на «самую мощную» по эвристическому скорингу.
 *
 * `allowAutoLoad` управляет агрессивной догрузкой моделей с диска. По
 * умолчанию ВЫКЛЮЧЕНА: загрузка второй большой LLM (gpuOffload=max) поверх
 * уже занятой VRAM в момент импорта тысячи файлов уже однажды повесила
 * Windows. Включается явно только в e2e-сценариях, где free VRAM проверена.
 */
export interface PickEvaluatorModelOptions {
  /** Явно выбранная пользователем модель (preferences.evaluatorModel). */
  preferred?: string;
  /** CSV-fallbacks (preferences.evaluatorModelFallbacks, уже распарсенный). */
  fallbacks?: string[];
  /**
   * Разрешить вызов `loadModel(...)` если ни один кандидат не загружен.
   * Default: false. Опасно при импорте — может вытолкнуть текущую модель
   * из VRAM или вызвать swap-thrashing вплоть до freeze ОС.
   */
  allowAutoLoad?: boolean;
  /** DI hook для тестов — подменить `listLoaded()`. */
  listLoadedImpl?: typeof listLoaded;
  /** DI hook для тестов — подменить `listDownloaded()`. */
  listDownloadedImpl?: typeof listDownloaded;
  /** DI hook для тестов — подменить `loadModel()`. */
  loadModelImpl?: typeof loadModel;
}

/**
 * Выбор модели для эвалюации книги.
 *
 * Порядок приоритетов:
 *   1. `opts.preferred` (если в loaded) — выбор пользователя сильнее любой эвристики.
 *   2. Любая модель из `opts.fallbacks` (если в loaded).
 *   3. Скоринг loaded-моделей (curated tags + heuristics) — топ-1.
 *   4. Только если `allowAutoLoad === true`: скоринг loaded ∪ downloaded
 *      и `loadModel` топа (старое поведение). По умолчанию выключено.
 *
 * Контракт: никогда не throw — при любой ошибке возвращает `null`, чтобы
 * evaluator-queue корректно пометил книгу как «no LLM».
 */
export async function pickEvaluatorModel(
  opts: PickEvaluatorModelOptions = {},
): Promise<string | null> {
  try {
    return await pickEvaluatorModelUnsafe(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[book-evaluator] pickEvaluatorModel:", msg);
    return null;
  }
}

async function pickEvaluatorModelUnsafe(
  opts: PickEvaluatorModelOptions,
): Promise<string | null> {
  const allowAutoLoad = opts.allowAutoLoad === true;
  const listLoadedFn = opts.listLoadedImpl ?? listLoaded;
  const listDownloadedFn = opts.listDownloadedImpl ?? listDownloaded;
  const loadModelFn = opts.loadModelImpl ?? loadModel;

  const loaded = await listLoadedFn();
  const loadedKeys = new Set(loaded.map((m) => m.modelKey));

  /* 1. Явно выбранная пользователем модель. */
  const preferred = opts.preferred?.trim();
  if (preferred && loadedKeys.has(preferred)) {
    return preferred;
  }

  /* 2. CSV fallbacks. Берём первый, который реально в loaded. */
  for (const candidate of opts.fallbacks ?? []) {
    const trimmed = candidate.trim();
    if (trimmed && loadedKeys.has(trimmed)) {
      return trimmed;
    }
  }

  /* Дальше — авто-выбор. Ограничиваемся только loaded моделями, если
     allowAutoLoad=false: НИКАКОЙ незаметной догрузки чужих моделей. */
  const downloaded = allowAutoLoad ? await listDownloadedFn() : [];

  const candidates = new Map<string, { sizeBytes: number; arch?: string }>();
  for (const m of loaded) candidates.set(m.modelKey, { sizeBytes: 0 });
  for (const m of downloaded) {
    const prev = candidates.get(m.modelKey);
    candidates.set(m.modelKey, { sizeBytes: m.sizeBytes ?? prev?.sizeBytes ?? 0, arch: m.architecture });
  }

  const llmKeys = [...candidates.entries()]
    .filter(([key, info]) => !isEmbedder(info.arch, key))
    .map(([key, info]) => ({ key, sizeBytes: info.sizeBytes }));

  if (llmKeys.length === 0) return null;

  const scored = await Promise.all(
    llmKeys.map((c) => scoreModel(c.key, loadedKeys, c.sizeBytes)),
  );
  scored.sort((a, b) => b.score - a.score || b.sizeBytes - a.sizeBytes);

  const top = scored[0];
  if (!top) return null;

  if (top.isLoaded) return top.modelKey;

  /* Не загружено и auto-load запрещён — отказ. Лучше пустой результат и
     явный warning «no evaluator model loaded», чем скрытая догрузка
     35b-модели поверх уже занятой VRAM. */
  if (!allowAutoLoad) return null;

  /* Старое поведение для e2e: WS-загрузка топа с TTL 15 мин, gpuOffload=max. */
  try {
    const handle = await loadModelFn(top.modelKey, { ttlSec: 900, gpuOffload: "max" });
    return handle.modelKey;
  } catch {
    for (const alt of scored.slice(1, 4)) {
      if (alt.isLoaded) return alt.modelKey;
      try {
        const handle = await loadModelFn(alt.modelKey, { ttlSec: 900, gpuOffload: "max" });
        return handle.modelKey;
      } catch { /* try next */ }
    }
    return null;
  }
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
              `Previous invalid answer to fix:\n${badRaw.slice(0, 4000)}`,
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
